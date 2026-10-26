// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AsyncIterableQueue,
  AudioByteStream,
  ConnectionPool,
  DEFAULT_API_CONNECT_OPTIONS,
  Event,
  Future,
  type TimedString,
  createTimedString,
  delay,
  log,
  shortuuid,
  toLanguageName,
  tokenize,
  tts,
  waitForWebSocketOpen,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';

const DEFAULT_BASE_URL = 'wss://tts.us.assemblyai.com';
const DEFAULT_MODEL = 'assemblyai-tts-1';
const DEFAULT_VOICE = '49c443a4-8a1d-5f7e-b70b-98bdbd9823c3'; // Audrey
const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const;

const MAX_REQUEST_CODEPOINTS = 2000;
const MAX_IN_FLIGHT_REQUESTS = 3;
const MAX_UNBROKEN_CODEPOINTS = 40;
const EXPIRY_MARGIN_MS = 60_000;
const WORD_BOUNDARIES_GRACE_MS = 500;
const NON_RETRYABLE_CODES = new Set([1008, 3006, 3010, 3011, 3012, 3014]);
const FLUSH_FRAME = JSON.stringify({ type: 'Flush' });
const CANCEL_FRAME = JSON.stringify({ type: 'Cancel' });
const NUM_CHANNELS = 1;

/** @internal */
export const _MAX_REQUEST_CHARS = MAX_REQUEST_CODEPOINTS;
/** @internal */
export const _MAX_UNBROKEN_CHARS = MAX_UNBROKEN_CODEPOINTS;
/** @internal */
export const _WORD_BOUNDARIES_GRACE = WORD_BOUNDARIES_GRACE_MS;

/** Options for AssemblyAI Streaming TTS. */
export interface TTSOptions {
  /** Catalog voice UUID or slug. Defaults to Audrey. */
  voice?: string;
  /** Language code or English language name. Omit to use the voice's default language. */
  language?: string | null;
  /** Model name or alias. */
  model?: string;
  /** PCM output sample rate. */
  sampleRate?: number;
  /** Request and emit word-level timestamps. */
  wordTimestamps?: boolean;
  /** Defaults to `ASSEMBLYAI_API_KEY`. */
  apiKey?: string;
  /** Streaming TTS host, including its `wss` scheme. */
  baseUrl?: string;
  /** Sentence tokenizer used to split streamed LLM output into requests. */
  tokenizer?: tokenize.SentenceTokenizer;
  /** Pace later sentence requests behind audio already generated for the stream. */
  textPacing?: boolean;
}

interface ResolvedTTSOptions {
  voice: string;
  language?: string;
  model: string;
  sampleRate: number;
  wordTimestamps: boolean;
  apiKey: string;
  baseUrl: string;
  tokenizer: tokenize.SentenceTokenizer;
  textPacing: boolean;
}

interface ServerFrame {
  type?: string;
  id?: string;
  expires_at?: number;
  configuration?: Record<string, unknown>;
  flush_id?: number;
  audio?: string;
  audio_duration_ms?: number;
  audio_start_ms?: number;
  words?: Array<{
    word?: string;
    start?: number;
    end?: number;
    confidence?: number;
  }>;
  error?: unknown;
  error_code?: unknown;
  error_type?: unknown;
  retryable?: unknown;
  retry_after_seconds?: unknown;
  [key: string]: unknown;
}

type ListenerItem = ServerFrame | APIError;

interface RequestState {
  text: string;
  segmentOffsetMs?: number;
  durationMs: number;
  done: boolean;
  transcriptPushed: boolean;
}

interface ConnectionLease {
  connection: AssemblyAIConnection;
  release: (discard: boolean) => void;
}

/** AssemblyAI Streaming TTS client. */
export class TTS extends tts.TTS {
  label = 'assemblyai.TTS';
  #opts: ResolvedTTSOptions;
  #pool: ConnectionPool<AssemblyAIConnection>;
  #streams = new Set<WeakRef<SynthesizeStream>>();
  #closed = false;
  // Bumped by updateOptions(). The pool only tracks a connection once its handshake finishes,
  // so invalidate() misses one still connecting; the generation catches it on checkout instead.
  #optionsGeneration = 0;
  #connectNotBefore = 0;
  #connectingSockets = new Set<WebSocket>();
  #pendingConnections = new Set<Promise<AssemblyAIConnection>>();
  #pendingConnectionCleanup = new Set<Promise<void>>();

  constructor(opts: TTSOptions = {}) {
    const sampleRate = opts.sampleRate ?? 24000;
    if (!SUPPORTED_SAMPLE_RATES.some((supported) => supported === sampleRate)) {
      throw new Error(
        `sampleRate must be one of ${SUPPORTED_SAMPLE_RATES.join(', ')}, but got ${sampleRate}`,
      );
    }

    const apiKey = opts.apiKey ?? process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new Error('AssemblyAI API key is required. Pass apiKey or set ASSEMBLYAI_API_KEY.');
    }

    const wordTimestamps = opts.wordTimestamps ?? true;
    super(sampleRate, NUM_CHANNELS, {
      streaming: true,
      alignedTranscript: wordTimestamps,
    });

    this.#opts = {
      voice: requireValue(opts.voice ?? DEFAULT_VOICE, 'voice'),
      language: opts.language == null ? undefined : languageName(opts.language),
      model: requireValue(opts.model ?? DEFAULT_MODEL, 'model'),
      sampleRate,
      wordTimestamps,
      apiKey,
      baseUrl: (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      tokenizer: opts.tokenizer ?? new tokenize.blingfire.SentenceTokenizer(),
      textPacing: opts.textPacing ?? false,
    };

    this.#pool = new ConnectionPool<AssemblyAIConnection>({
      connectCb: (timeoutMs, signal) => this.#connect(timeoutMs, signal),
      closeCb: (connection) => connection.close(),
      connectTimeout: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
    });
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'AssemblyAI';
  }

  /** @internal */
  get _opts(): TTSOptions {
    return this.#opts;
  }

  updateOptions(opts: Pick<TTSOptions, 'voice' | 'language' | 'model'>): void {
    const voice = opts.voice === undefined ? this.#opts.voice : requireValue(opts.voice, 'voice');
    const language =
      opts.language === undefined
        ? this.#opts.language
        : opts.language === null
          ? undefined
          : languageName(opts.language);
    const model = opts.model === undefined ? this.#opts.model : requireValue(opts.model, 'model');

    if (
      voice !== this.#opts.voice ||
      language !== this.#opts.language ||
      model !== this.#opts.model
    ) {
      this.#opts.voice = voice;
      this.#opts.language = language;
      this.#opts.model = model;
      this.#optionsGeneration += 1;
      this.#pool.invalidate();
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new StreamingChunkedStream(this, text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const stream = new SynthesizeStream(this, options?.connOptions);
    const ref = new WeakRef(stream);
    this.#streams.add(ref);
    void stream.done.await.then(() => this.#streams.delete(ref));
    return stream;
  }

  prewarm(): void {
    this.#pool.prewarm();
  }

  override async releaseIdleConnections(): Promise<void> {
    await this.#pool.releaseIdle();
  }

  override async close(): Promise<void> {
    this.#closed = true;
    const streams = [...this.#streams].flatMap((ref) => {
      const stream = ref.deref();
      return stream ? [stream] : [];
    });
    for (const stream of streams) stream.close();
    for (const socket of this.#connectingSockets) closeWebSocket(socket);
    await Promise.all(streams.map((stream) => stream.done.await));
    this.#streams.clear();
    await Promise.allSettled(this.#pendingConnections);
    await Promise.allSettled(this.#pendingConnectionCleanup);
    await this.#pool.close();
    await super.close();
  }

  noteRetryAfter(error: APIError): void {
    if (!(error instanceof APIStatusError) || typeof error.body !== 'object' || !error.body) return;
    const retryAfter = (error.body as ServerFrame).retry_after_seconds;
    if (typeof retryAfter === 'number' && retryAfter > 0) {
      this.#connectNotBefore = Math.max(this.#connectNotBefore, Date.now() + retryAfter * 1000);
    }
  }

  async acquire(timeoutMs: number, signal: AbortSignal): Promise<ConnectionLease> {
    while (true) {
      const pendingConnection = this.#pool.get(timeoutMs, signal);
      this.#pendingConnections.add(pendingConnection);
      void pendingConnection.then(
        () => this.#pendingConnections.delete(pendingConnection),
        () => this.#pendingConnections.delete(pendingConnection),
      );
      const connection = await raceWithAbort(pendingConnection, signal);
      if (!connection) {
        const cleanup = pendingConnection
          .then((opened) => this.#pool.remove(opened))
          .catch(() => {});
        this.#pendingConnectionCleanup.add(cleanup);
        void cleanup.then(
          () => this.#pendingConnectionCleanup.delete(cleanup),
          () => this.#pendingConnectionCleanup.delete(cleanup),
        );
        throw new Error('aborted');
      }
      if (connection.optionsGeneration !== this.#optionsGeneration) {
        this.#pool.remove(connection);
        continue;
      }
      if (connection.usable) {
        let released = false;
        return {
          connection,
          release: (discard) => {
            if (released) return;
            released = true;
            if (
              discard ||
              !connection.usable ||
              connection.optionsGeneration !== this.#optionsGeneration
            ) {
              this.#pool.remove(connection);
            } else {
              this.#pool.put(connection);
            }
          },
        };
      }

      this.#pool.remove(connection);
      if (connection.error) this.noteRetryAfter(connection.error);
      if (!connection.wasUsed) {
        throw (
          connection.error ??
          new APIConnectionError({
            message: `AssemblyAI TTS session ${connection.sessionId} was unusable as soon as it opened`,
          })
        );
      }
    }
  }

  async #connect(timeoutMs: number, signal?: AbortSignal): Promise<AssemblyAIConnection> {
    const waitMs = this.#connectNotBefore - Date.now();
    if (waitMs > 0) {
      if (waitMs > timeoutMs) {
        throw new APIConnectionError({
          message: `AssemblyAI TTS asked to wait ${(waitMs / 1000).toFixed(1)}s before opening a session`,
          options: { retryable: false },
        });
      }
      if (signal) {
        await raceWithAbort(delay(waitMs), signal);
        signal.throwIfAborted();
      } else {
        await delay(waitMs);
      }
    }

    const opts = { ...this.#opts };
    const optionsGeneration = this.#optionsGeneration;
    const url = new URL(`${opts.baseUrl}/v1/ws`);
    url.searchParams.set('model_id', opts.model);
    url.searchParams.set('voice_id', opts.voice);
    url.searchParams.set('sample_rate', String(opts.sampleRate));
    url.searchParams.set('encoding', 'pcm_s16le');
    url.searchParams.set('word_boundaries', String(opts.wordTimestamps));
    if (opts.language !== undefined) url.searchParams.set('language', opts.language);

    const ws = new WebSocket(url, {
      headers: { Authorization: opts.apiKey },
      handshakeTimeout: timeoutMs,
    });
    this.#connectingSockets.add(ws);
    const abort = () => closeWebSocket(ws);
    signal?.addEventListener('abort', abort, { once: true });

    try {
      // AssemblyAI can send Begin in the same turn as the upgrade. Subscribe before
      // awaiting open so that frame cannot land between the two listeners.
      const beginPromise = receiveFrame(ws, timeoutMs);
      const [, begin] = await Promise.all([
        waitForWebSocketOpen(ws, 'AssemblyAI TTS'),
        beginPromise,
      ]);
      if (!begin) {
        throw new APIStatusError({
          message: 'AssemblyAI TTS connection closed before Begin',
          options: { statusCode: -1, retryable: true },
        });
      }
      if (begin.type === 'Error') {
        const error = errorFromFrame(begin, null);
        this.noteRetryAfter(error);
        throw error;
      }
      if (begin.type !== 'Begin') {
        throw new APIConnectionError({
          message: `expected Begin from AssemblyAI TTS, got ${JSON.stringify(begin.type)}`,
        });
      }
      if (this.#closed) {
        throw new APIConnectionError({
          message: 'AssemblyAI TTS is closed',
          options: { retryable: false },
        });
      }

      const connection = new AssemblyAIConnection(ws, begin, optionsGeneration);
      log().debug(
        { sessionId: connection.sessionId, configuration: connection.configuration },
        'connected to AssemblyAI TTS',
      );
      if (opts.wordTimestamps && !connection.wordBoundaries) {
        log().warn(
          { sessionId: connection.sessionId },
          'AssemblyAI TTS cannot supply word timings; transcript timing will be per sentence',
        );
      }
      return connection;
    } catch (error) {
      closeWebSocket(ws);
      if (error instanceof APIError) throw error;
      throw new APIConnectionError({
        message: `failed to connect to AssemblyAI TTS (${errorName(error)})`,
      });
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#connectingSockets.delete(ws);
    }
  }
}

class StreamingChunkedStream extends tts.ChunkedStream {
  label = 'assemblyai.ChunkedStream';
  #tts: TTS;
  #text: string;
  #connOptions: APIConnectOptions;

  constructor(
    instance: TTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, instance, connOptions, abortSignal);
    this.#tts = instance;
    this.#text = text;
    this.#connOptions = connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
  }

  protected async run(): Promise<void> {
    const stream = this.#tts.stream({ connOptions: this.#connOptions });
    const abort = () => stream.close();
    let emittedOutput = false;
    this.abortSignal.addEventListener('abort', abort, { once: true });
    try {
      stream.pushText(this.#text);
      stream.endInput();
      for await (const audio of stream) {
        if (audio === tts.SynthesizeStream.END_OF_STREAM) break;
        emittedOutput = true;
        this.queue.put(audio);
      }
      if (stream.error) throw emittedOutput ? withoutRetry(stream.error) : stream.error;
    } finally {
      this.abortSignal.removeEventListener('abort', abort);
      stream.close();
    }
  }
}

/** Streaming synthesis over a pooled AssemblyAI session. */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'assemblyai.SynthesizeStream';
  #tts: TTS;
  #opts: ResolvedTTSOptions;
  readonly done = new Future<void>();

  constructor(instance: TTS, connOptions?: APIConnectOptions) {
    super(instance, { ...(connOptions ?? DEFAULT_API_CONNECT_OPTIONS) });
    this.#tts = instance;
    this.#opts = { ...(instance._opts as ResolvedTTSOptions) };
  }

  /** @internal */
  get connectionTimeout(): number {
    return this.connOptions.timeoutMs;
  }

  /** @internal */
  get cancellationSignal(): AbortSignal {
    return this.abortSignal;
  }

  /** @internal */
  markProviderStarted(): void {
    this.markStarted();
    // Retrying after Generate could replay speech the caller has already heard.
    this.connOptions.maxRetry = 0;
  }

  /** @internal */
  emitAudio(audio: tts.SynthesizedAudio): void {
    this.queue.put(audio);
  }

  protected async run(): Promise<void> {
    let lease: ConnectionLease;
    try {
      lease = await this.#tts.acquire(this.connOptions.timeoutMs, this.abortSignal);
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) {
        this.#tts.noteRetryAfter(error);
        throw error;
      }
      throw new APIConnectionError({
        message: 'failed to acquire an AssemblyAI TTS connection',
      });
    }

    const connection = lease.connection;
    connection.wasUsed = true;
    if (connection.sessionId) this.noteProviderRequestId(connection.sessionId);
    const sentenceStream = this.#opts.tokenizer.stream();
    const listener = connection.attach();
    const run = new StreamRun(connection, listener, this, this.#opts);
    let discard = true;

    const runController = new AbortController();
    const abortRun = () => runController.abort(this.abortSignal.reason);
    this.abortSignal.addEventListener('abort', abortRun, { once: true });
    const inputTask = async () => {
      try {
        while (!runController.signal.aborted) {
          const { done, value: data } = await this.input.next({ signal: runController.signal });
          if (done) break;
          if (data === SynthesizeStream.FLUSH_SENTINEL) sentenceStream.flush();
          else sentenceStream.pushText(data);
        }
      } catch (error) {
        if (!runController.signal.aborted) throw error;
      } finally {
        if (!sentenceStream.closed) sentenceStream.endInput();
      }
    };
    const tasks = [inputTask(), run.execute(sentenceStream, runController.signal)];

    try {
      await Promise.all(tasks);
      discard = false;
      if (!this.queue.closed) this.queue.put(SynthesizeStream.END_OF_STREAM);
    } catch (error) {
      if (this.abortSignal.aborted) {
        if (run.hasOutstanding) {
          try {
            connection.cancel();
          } catch (cancelError) {
            if (!(cancelError instanceof APIError)) throw cancelError;
          }
        }
        discard = false;
        return;
      }
      if (error instanceof APIError) {
        this.#tts.noteRetryAfter(error);
        throw error;
      }
      throw new APIConnectionError({
        message: `AssemblyAI TTS stream failed (session ${connection.sessionId})`,
      });
    } finally {
      runController.abort();
      sentenceStream.close();
      await Promise.allSettled(tasks);
      this.abortSignal.removeEventListener('abort', abortRun);
      connection.detach(listener);
      lease.release(discard);
    }
  }

  protected override onStreamDone(): void {
    if (!this.done.done) this.done.resolve();
  }
}

class StreamRun {
  #connection: AssemblyAIConnection;
  #listener: ConnectionListener;
  #stream: SynthesizeStream;
  #opts: ResolvedTTSOptions;
  #requests: RequestState[] = [];
  #numDone = 0;
  #bytesPerSecond: number;
  #wordTimings: boolean;
  #requestId = shortuuid();
  #segmentId = shortuuid();
  #byteStream: AudioByteStream;
  #pendingTranscripts: TimedString[] = [];

  constructor(
    connection: AssemblyAIConnection,
    listener: ConnectionListener,
    stream: SynthesizeStream,
    opts: ResolvedTTSOptions,
  ) {
    this.#connection = connection;
    this.#listener = listener;
    this.#stream = stream;
    this.#opts = opts;
    this.#bytesPerSecond = opts.sampleRate * 2;
    this.#wordTimings = opts.wordTimestamps && connection.wordBoundaries;
    this.#byteStream = new AudioByteStream(opts.sampleRate, NUM_CHANNELS);
  }

  get hasOutstanding(): boolean {
    return this.#numDone < this.#requests.length;
  }

  async execute(sentenceStream: tokenize.SentenceStream, outerSignal: AbortSignal): Promise<void> {
    let segmentBytes = 0;
    let inputDone = false;
    const progress = new Event();
    const controller = new AbortController();
    const abort = () => controller.abort(outerSignal.reason);
    outerSignal.addEventListener('abort', abort, { once: true });

    const sendTask = async () => {
      for await (const event of sentenceStream) {
        for (const text of splitRequestText(event.token)) {
          while (
            this.#opts.textPacing &&
            this.#requests.length > 0 &&
            this.#requests.length !== this.#numDone
          ) {
            progress.clear();
            if (
              this.#requests.length !== this.#numDone &&
              (await raceWithAbort(
                progress.wait().then(() => true),
                controller.signal,
              )) === undefined
            ) {
              return;
            }
          }
          while (this.#requests.length - this.#numDone >= MAX_IN_FLIGHT_REQUESTS) {
            progress.clear();
            if (this.#requests.length - this.#numDone >= MAX_IN_FLIGHT_REQUESTS) {
              if (
                (await raceWithAbort(
                  progress.wait().then(() => true),
                  controller.signal,
                )) === undefined
              ) {
                return;
              }
            }
          }
          this.#stream.markProviderStarted();
          this.#connection.send(JSON.stringify({ type: 'Generate', text }));
          this.#connection.send(FLUSH_FRAME);
          this.#requests.push({
            text,
            durationMs: 0,
            done: false,
            transcriptPushed: false,
          });
          progress.set();
        }
      }
      inputDone = true;
      progress.set();
    };

    const recvTask = async () => {
      while (true) {
        let item: ListenerItem | undefined;
        if (this.#numDone === this.#requests.length) {
          if (inputDone) break;
          progress.clear();
          if (this.#numDone !== this.#requests.length || inputDone) continue;
          item = await this.#receiveUntil(progress, controller.signal);
          if (!item) continue;
        } else {
          item = await receiveWithTimeout(
            this.#listener,
            controller.signal,
            this.#stream.connectionTimeout,
            () =>
              new APITimeoutError({
                message: `AssemblyAI TTS sent nothing for ${this.#stream.connectionTimeout}ms (session ${this.#connection.sessionId})`,
              }),
          );
        }

        if (item instanceof APIError) throw item;
        const request = this.#requestFor(item);
        if (!request) continue;

        if (item.type === 'Audio' && typeof item.audio === 'string') {
          const audio = Buffer.from(item.audio, 'base64');
          if (request.segmentOffsetMs === undefined) {
            request.segmentOffsetMs = (segmentBytes * 1000) / this.#bytesPerSecond;
          }
          segmentBytes += audio.byteLength;
          this.#pushAudio(audio);
        } else if (item.type === 'FlushDone') {
          request.done = true;
          request.durationMs =
            typeof item.audio_duration_ms === 'number' ? item.audio_duration_ms : 0;
          this.#numDone += 1;
          progress.set();
          if (!this.#wordTimings) {
            this.#pushUntimed(request);
            this.#emitPending(false);
          }
        } else if (item.type === 'WordBoundaries') {
          this.#pushWordBoundaries(request, item);
        }
      }

      for (const frame of this.#byteStream.flush()) this.#bufferFrame(frame);
      await this.#awaitWordBoundaries(controller.signal);
      if (this.#requests.length > 0) this.#emitPending(true);
    };

    const tasks = [sendTask(), recvTask()];
    try {
      await Promise.all(tasks);
    } finally {
      controller.abort();
      progress.set();
      sentenceStream.close();
      await Promise.allSettled(tasks);
      outerSignal.removeEventListener('abort', abort);
    }
  }

  async #receiveUntil(event: Event, signal: AbortSignal): Promise<ListenerItem | undefined> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const receive = this.#listener.receive(controller.signal);
    try {
      const winner = await Promise.race([
        receive.then((item) => ({ item })),
        event.wait().then(() => ({ item: undefined })),
      ]);
      return winner.item;
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  #requestFor(item: ServerFrame): RequestState | undefined {
    if (typeof item.flush_id !== 'number' || this.#listener.baseFlushId === undefined) return;
    const index = item.flush_id - this.#listener.baseFlushId;
    if (index < 0) return;
    if (index >= this.#requests.length) {
      log().warn(
        { sessionId: this.#connection.sessionId, flushId: item.flush_id },
        'AssemblyAI TTS sent a frame for an unknown request',
      );
      return;
    }
    return this.#requests[index];
  }

  async #awaitWordBoundaries(signal: AbortSignal): Promise<void> {
    if (!this.#wordTimings) return;
    const deadline = Date.now() + WORD_BOUNDARIES_GRACE_MS;
    while (this.#requests.some((request) => this.#awaitingWords(request))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let item: ListenerItem;
      try {
        item = await receiveWithTimeout(
          this.#listener,
          signal,
          remaining,
          () => new APITimeoutError({ message: 'word boundaries grace period elapsed' }),
        );
      } catch (error) {
        if (error instanceof APITimeoutError) break;
        throw error;
      }
      if (item instanceof APIError) {
        log().warn({ error: item }, 'AssemblyAI TTS failed while waiting for word boundaries');
        break;
      }
      if (item.type === 'WordBoundaries') {
        const request = this.#requestFor(item);
        if (request) this.#pushWordBoundaries(request, item);
      }
    }
    for (const request of this.#requests) this.#pushUntimed(request);
  }

  #awaitingWords(request: RequestState): boolean {
    return request.segmentOffsetMs !== undefined && !request.transcriptPushed;
  }

  #pushWordBoundaries(request: RequestState, item: ServerFrame): void {
    if (request.transcriptPushed || request.segmentOffsetMs === undefined) return;
    const index = this.#requests.indexOf(request);
    for (const earlier of this.#requests.slice(0, index)) this.#pushUntimed(earlier);

    const audioStartMs = typeof item.audio_start_ms === 'number' ? item.audio_start_ms : 0;
    const offsetMs = request.segmentOffsetMs - audioStartMs;
    const words: TimedString[] = [];
    for (const word of item.words ?? []) {
      if (!word.word || typeof word.start !== 'number' || typeof word.end !== 'number') {
        continue;
      }
      words.push(
        createTimedString({
          text: `${word.word} `,
          startTime: (offsetMs + word.start) / 1000,
          endTime: (offsetMs + word.end) / 1000,
          confidence: word.confidence,
        }),
      );
    }
    request.transcriptPushed = true;
    if (words.length) this.#pendingTranscripts.push(...words);
    else this.#pushText(request);
    this.#emitPending(false);
  }

  #pushUntimed(request: RequestState): void {
    if (request.transcriptPushed || !request.done) return;
    request.transcriptPushed = true;
    this.#pushText(request);
  }

  #pushText(request: RequestState): void {
    if (!this.#opts.wordTimestamps || request.segmentOffsetMs === undefined) return;
    this.#pendingTranscripts.push(
      createTimedString({
        text: `${request.text} `,
        startTime: request.segmentOffsetMs / 1000,
        endTime: (request.segmentOffsetMs + request.durationMs) / 1000,
      }),
    );
  }

  #pushAudio(audio: Buffer): void {
    for (const frame of this.#byteStream.write(audio)) this.#bufferFrame(frame);
  }

  #bufferFrame(frame: AudioFrame): void {
    this.#stream.emitAudio({
      requestId: this.#requestId,
      segmentId: this.#segmentId,
      frame,
      final: false,
      timedTranscripts: this.#takePendingTranscripts(),
    });
  }

  #emitPending(final: boolean): void {
    if (!final && this.#pendingTranscripts.length === 0) return;
    this.#stream.emitAudio({
      requestId: this.#requestId,
      segmentId: this.#segmentId,
      frame: new AudioFrame(new Int16Array(), this.#opts.sampleRate, NUM_CHANNELS, 0),
      final,
      timedTranscripts: this.#takePendingTranscripts(),
    });
  }

  #takePendingTranscripts(): TimedString[] | undefined {
    const transcripts = this.#pendingTranscripts.length ? this.#pendingTranscripts : undefined;
    this.#pendingTranscripts = [];
    return transcripts;
  }
}

class ConnectionListener {
  readonly queue = new AsyncIterableQueue<ListenerItem>();
  baseFlushId?: number;

  push(item: ListenerItem): void {
    if (!this.queue.closed) this.queue.put(item);
  }

  async receive(signal?: AbortSignal): Promise<ListenerItem> {
    const result = await this.queue.next({ signal });
    if (result.done) {
      throw new APIConnectionError({ message: 'AssemblyAI TTS listener closed' });
    }
    return result.value;
  }

  close(): void {
    if (!this.queue.closed) this.queue.close();
  }
}

class AssemblyAIConnection {
  readonly sessionId: string | null;
  readonly configuration: Record<string, unknown>;
  readonly expiresAt: number;
  readonly wordBoundaries: boolean;
  readonly optionsGeneration: number;
  wasUsed = false;
  #ws: WebSocket;
  #expiryMargin: number;
  #cancelsPending = 0;
  #listener?: ConnectionListener;
  #error?: APIError;
  #closed = false;
  #sendQueue = new AsyncIterableQueue<string>();
  #sendTask: Promise<void>;
  #receiveTask: Promise<void>;

  constructor(ws: WebSocket, begin: ServerFrame, optionsGeneration: number) {
    this.#ws = ws;
    this.optionsGeneration = optionsGeneration;
    this.sessionId = typeof begin.id === 'string' ? begin.id : null;
    this.configuration = begin.configuration ?? {};
    this.expiresAt =
      typeof begin.expires_at === 'number' ? begin.expires_at * 1000 : Date.now() + 3_600_000;
    this.wordBoundaries = this.configuration.word_boundaries === true;
    this.#expiryMargin = Math.min(EXPIRY_MARGIN_MS, (this.expiresAt - Date.now()) / 2);
    this.#sendTask = this.#sendLoop();
    this.#receiveTask = this.#receiveLoop();
  }

  get usable(): boolean {
    return (
      !this.#closed &&
      !this.#error &&
      this.#ws.readyState === WebSocket.OPEN &&
      Date.now() < this.expiresAt - this.#expiryMargin
    );
  }

  get error(): APIError | undefined {
    return this.#error;
  }

  attach(): ConnectionListener {
    const listener = new ConnectionListener();
    if (this.#error) listener.push(this.#error);
    this.#listener = listener;
    return listener;
  }

  detach(listener: ConnectionListener): void {
    if (this.#listener === listener) this.#listener = undefined;
    listener.close();
  }

  send(frame: string): void {
    if (this.#error) throw this.#error;
    if (this.#closed || this.#sendQueue.closed) {
      throw new APIConnectionError({
        message: `AssemblyAI TTS session ${this.sessionId} is closed`,
      });
    }
    this.#sendQueue.put(frame);
  }

  cancel(): void {
    this.send(CANCEL_FRAME);
    this.#cancelsPending += 1;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#sendQueue.closed) this.#sendQueue.close();
    closeWebSocket(this.#ws);
    await Promise.allSettled([this.#sendTask, this.#receiveTask]);
  }

  #fail(error: APIError): void {
    if (this.#error) return;
    this.#error = error;
    this.#listener?.push(error);
  }

  async #sendLoop(): Promise<void> {
    try {
      for await (const frame of this.#sendQueue) {
        await sendWebSocket(this.#ws, frame);
      }
    } catch (error) {
      this.#fail(
        new APIConnectionError({
          message: `failed to send to AssemblyAI TTS session ${this.sessionId}: ${errorName(error)}`,
        }),
      );
    }
  }

  async #receiveLoop(): Promise<void> {
    const frames = new AsyncIterableQueue<ServerFrame | null>();
    let closeCode = 1006;
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const frame = parseFrame(data);
      if (frame && !frames.closed) frames.put(frame);
    };
    const onClose = (code: number) => {
      closeCode = code || 1006;
      if (!frames.closed) frames.put(null);
    };
    const onError = (error: Error) => {
      this.#fail(
        new APIConnectionError({
          message: `failed to read from AssemblyAI TTS session ${this.sessionId}: ${error.name}`,
        }),
      );
      if (!frames.closed) frames.put(null);
    };
    this.#ws.on('message', onMessage);
    this.#ws.once('close', onClose);
    this.#ws.once('error', onError);

    try {
      for await (const frame of frames) {
        if (frame === null) break;
        this.#onFrame(frame);
      }
    } finally {
      frames.close();
      this.#ws.off('message', onMessage);
      this.#ws.off('close', onClose);
      this.#ws.off('error', onError);
      if (!this.#sendQueue.closed) this.#sendQueue.close();
    }

    if (!this.#closed && !this.#error) {
      this.#fail(
        new APIStatusError({
          message: `AssemblyAI TTS session ${this.sessionId} closed unexpectedly`,
          options: {
            statusCode: closeCode,
            requestId: this.sessionId,
            retryable: true,
          },
        }),
      );
    }
  }

  #onFrame(frame: ServerFrame): void {
    if (frame.type === 'Error') {
      const error = errorFromFrame(frame, this.sessionId);
      log().warn(
        {
          sessionId: this.sessionId,
          errorCode: frame.error_code,
          errorType: frame.error_type,
        },
        error.message,
      );
      this.#fail(error);
      return;
    }

    if (frame.type === 'Cancelled') {
      if (this.#cancelsPending === 0) {
        log().warn({ sessionId: this.sessionId }, 'AssemblyAI TTS sent an unexpected Cancelled');
      } else {
        this.#cancelsPending -= 1;
      }
      return;
    }

    if (!['Audio', 'FlushDone', 'WordBoundaries'].includes(frame.type ?? '')) return;
    const listener = this.#listener;
    if (typeof frame.flush_id !== 'number' || this.#cancelsPending > 0 || !listener) return;
    if (listener.baseFlushId === undefined) {
      if (frame.type === 'WordBoundaries') return;
      listener.baseFlushId = frame.flush_id;
    }
    listener.push(frame);
  }
}

async function receiveFrame(ws: WebSocket, timeoutMs: number): Promise<ServerFrame | null> {
  const frame = new Future<ServerFrame | null>();
  const onMessage = (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const parsed = parseFrame(data);
    if (parsed && !frame.done) frame.resolve(parsed);
  };
  const onClose = () => {
    if (!frame.done) frame.resolve(null);
  };
  const onError = (error: Error) => {
    if (!frame.done) frame.reject(error);
  };
  ws.on('message', onMessage);
  ws.once('close', onClose);
  ws.once('error', onError);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      frame.await,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new APITimeoutError({
                message: 'timed out waiting for AssemblyAI TTS Begin',
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    ws.off('message', onMessage);
    ws.off('close', onClose);
    ws.off('error', onError);
  }
}

function parseFrame(data: RawData): ServerFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ServerFrame;
    }
  } catch {
    log().warn('AssemblyAI TTS sent a frame that is not JSON');
  }
  return;
}

/** @internal */
export function _errorFromFrame(
  frame: Record<string, unknown>,
  sessionId: string | null,
): APIStatusError {
  return errorFromFrame(frame as ServerFrame, sessionId);
}

function errorFromFrame(frame: ServerFrame, sessionId: string | null): APIStatusError {
  const code = typeof frame.error_code === 'number' ? frame.error_code : -1;
  const retryable =
    typeof frame.retryable === 'boolean' ? frame.retryable : !NON_RETRYABLE_CODES.has(code);
  const kind = typeof frame.error_type === 'string' ? ` (${frame.error_type})` : '';
  return new APIStatusError({
    message: `AssemblyAI TTS error ${code}${kind}: ${String(frame.error ?? '')}`,
    options: {
      statusCode: code,
      requestId: sessionId,
      body: frame,
      retryable,
    },
  });
}

function requireValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`\`${name}\` must not be empty`);
  return normalized;
}

function languageName(language: string): string {
  const value = requireValue(language, 'language');
  return toLanguageName(value) ?? value.toLowerCase();
}

/** @internal */
export function _splitRequestText(input: string): string[] {
  return splitRequestText(input);
}

function splitRequestText(input: string): string[] {
  const chars: string[] = [];
  let unbroken = 0;
  for (const char of Array.from(input.trim())) {
    if (/\s/u.test(char)) {
      unbroken = 0;
    } else {
      unbroken += 1;
      if (unbroken > MAX_UNBROKEN_CODEPOINTS) {
        chars.push(' ');
        unbroken = 1;
      }
    }
    chars.push(char);
  }

  let text = chars.join('').trim();
  const pieces: string[] = [];
  while (Array.from(text).length > MAX_REQUEST_CODEPOINTS) {
    const codepoints = Array.from(text);
    let cut = MAX_REQUEST_CODEPOINTS;
    for (let i = MAX_REQUEST_CODEPOINTS; i >= 0; i -= 1) {
      if (/\s/u.test(codepoints[i] ?? '')) {
        cut = i;
        break;
      }
    }
    pieces.push(codepoints.slice(0, cut).join('').trim());
    text = codepoints.slice(cut).join('').trim();
  }
  if (text) pieces.push(text);
  return pieces;
}

async function receiveWithTimeout(
  listener: ConnectionListener,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<ListenerItem> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      listener.receive(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(timeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return;
  let abort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function sendWebSocket(ws: WebSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(data, (error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocket(ws: WebSocket): void {
  ws.on('error', () => {});
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.terminate();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function withoutRetry(error: Error): Error {
  if (error instanceof APIStatusError) {
    return new APIStatusError({
      message: error.message,
      options: {
        statusCode: error.statusCode,
        requestId: error.requestId,
        body: error.body,
        retryable: false,
      },
    });
  }
  if (error instanceof APIError) {
    return new APIConnectionError({
      message: error.message,
      options: { retryable: false },
    });
  }
  return error;
}
