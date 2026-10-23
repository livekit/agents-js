// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  type VAD,
  VADEventType,
  intervalForRetry,
  normalizeLanguage,
  stt,
} from '@livekit/agents';
import { type AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type { ClientOptions, RawData } from 'ws';
import { WebSocket } from 'ws';
import { Configuration, HTTPClient, positiveTimeout, statusError } from './http.js';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const CHUNK_SAMPLES = 800;
const MAX_TEXT_LENGTH = 65_536;
const MAX_INPUT_ITEMS = 1024;
const MAX_INCOMING_EVENTS = 1024;
const TRANSCRIPTION = 'conversation.item.input_audio_transcription.';

/** Creates the WebSocket transport used by a Microsoft AI STT stream. */
export type WebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

/** Microsoft AI native realtime transcription options. */
export interface STTOptions {
  /** A client VAD, or null when turns are committed with flush/endInput. */
  vad: VAD | null;
  /** Full realtime transcription WebSocket URL. Defaults to MICROSOFT_AI_STT_URL. */
  url?: string;
  /** Deployment model identifier. Defaults to MICROSOFT_AI_STT_MODEL. */
  model?: string;
  /** API credential. Defaults to MICROSOFT_AI_STT_API_KEY. */
  apiKey?: string;
  /** Header used for apiKey. Defaults to MICROSOFT_AI_STT_AUTH_HEADER or Authorization. */
  authHeader?: 'Authorization' | 'api-key';
  /** Explicit authentication headers, instead of apiKey/authHeader lookup. */
  headers?: Record<string, string>;
  /** Optional language hint. Defaults to MICROSOFT_AI_STT_LANGUAGE. */
  language?: string;
  /** Explicit dotenv file. Defaults to MICROSOFT_AI_ENV_FILE; never mutates process.env. */
  envFile?: string;
  /** Maximum locally buffered audio, in milliseconds. */
  maxBufferedAudio?: number;
  /** Custom WebSocket constructor, primarily for managed transports and testing. */
  webSocketFactory?: WebSocketFactory;
}

/** Per-stream Microsoft AI transcription options. */
export interface SpeechStreamOptions {
  language?: string;
  connOptions?: APIConnectOptions;
}

interface ResolvedOptions {
  vad: VAD | null;
  url: string;
  model: string;
  headers: Record<string, string>;
  language?: string;
  maxBufferedAudio: number;
  webSocketFactory: WebSocketFactory;
}

interface ItemState {
  id: string;
  finalized: string;
  hypothesis: string;
  lastInterim: string;
}

type IncomingEvent =
  | { kind: 'message'; data: RawData; isBinary: boolean }
  | { kind: 'close'; code: number }
  | { kind: 'error'; error: Error };

class WebSocketInbox {
  readonly #events: IncomingEvent[] = [];
  readonly #waiters: Array<(event: IncomingEvent) => void> = [];
  #overflowed = false;

  constructor(ws: WebSocket) {
    ws.on('message', (data, isBinary) => this.#push({ kind: 'message', data, isBinary }));
    ws.on('close', (code) => this.#push({ kind: 'close', code }));
    ws.on('error', (error) => this.#push({ kind: 'error', error }));
  }

  #push(event: IncomingEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    if (this.#events.length >= MAX_INCOMING_EVENTS) {
      if (!this.#overflowed) {
        this.#overflowed = true;
        this.#events.length = 0;
        this.#events.push({ kind: 'error', error: new Error('incoming event queue overflow') });
      }
      return;
    }
    this.#events.push(event);
  }

  async next(signal: AbortSignal): Promise<IncomingEvent> {
    const event = this.#events.shift();
    if (event) return event;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(onEvent);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal.reason);
      };
      const onEvent = (next: IncomingEvent) => {
        signal.removeEventListener('abort', onAbort);
        resolve(next);
      };
      this.#waiters.push(onEvent);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, retryable: boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new APITimeoutError({
            message: 'Microsoft AI STT operation timed out',
            options: { retryable },
          }),
        ),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function providerError(event: Record<string, unknown>): APIError {
  const error = event.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const details = error as Record<string, unknown>;
    if (
      typeof details.status_code === 'number' &&
      Number.isInteger(details.status_code) &&
      details.status_code >= 400 &&
      details.status_code < 600
    ) {
      return statusError('STT', details.status_code);
    }
    if (typeof details.code === 'string') {
      const status = (
        {
          invalid_api_key: 401,
          rate_limit_exceeded: 429,
          content_filter: 403,
          safety_violation: 403,
        } as Record<string, number>
      )[details.code];
      if (status !== undefined) return statusError('STT', status);
    }
  }
  return new APIError('Microsoft AI STT rejected the transcription request', {
    retryable: false,
  });
}

function stringField(event: Record<string, unknown>, key: string, nonempty = false): string {
  const value = event[key];
  if (typeof value !== 'string' || (nonempty && !value)) {
    throw new APIError(`Microsoft AI STT event requires a string ${key}`, { retryable: false });
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new APIError('Microsoft AI STT event exceeds the text limit', { retryable: false });
  }
  return value;
}

function sessionUpdate(model: string, language?: string): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          transcription: { model, ...(language === undefined ? {} : { language }) },
          turn_detection: null,
          noise_reduction: null,
        },
      },
    },
  };
}

function bytes(frame: AudioFrame): Buffer {
  return Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
}

function sanitizedConnectionError(audioConsumed: boolean): APIConnectionError {
  return new APIConnectionError({
    message: 'Microsoft AI STT transport failed',
    options: { retryable: !audioConsumed },
  });
}

function asNonRetryable(error: APIError): APIError {
  if (error instanceof APIStatusError) {
    return new APIStatusError({
      message: error.message,
      options: {
        statusCode: error.statusCode,
        requestId: error.requestId,
        body: null,
        retryable: false,
      },
    });
  }
  if (error instanceof APITimeoutError) {
    return new APITimeoutError({ message: error.message, options: { retryable: false } });
  }
  if (error instanceof APIConnectionError) {
    return new APIConnectionError({ message: error.message, options: { retryable: false } });
  }
  return new APIError(error.message, { body: null, retryable: false });
}

/** Native streaming Microsoft AI transcription with explicit client commits. */
export class STT extends stt.STT {
  readonly #opts: ResolvedOptions;
  readonly #streams = new Set<SpeechStream>();
  #closed = false;
  label = 'microsoft.STT';

  constructor(opts: STTOptions) {
    super({
      streaming: true,
      interimResults: true,
      alignedTranscript: false,
      diarization: false,
    });
    const config = new Configuration(opts.envFile);
    const model = config.required(opts.model, 'MICROSOFT_AI_STT_MODEL');
    let language = opts.language;
    if (language === undefined) language = config.get('MICROSOFT_AI_STT_LANGUAGE') || undefined;
    if (language !== undefined && !language.trim()) {
      throw new Error('language must be nonempty when supplied');
    }
    const maxBufferedAudio = opts.maxBufferedAudio ?? 5000;
    positiveTimeout(maxBufferedAudio, 'maxBufferedAudio');
    const client = new HTTPClient({
      config,
      service: 'STT',
      url: config.required(opts.url, 'MICROSOFT_AI_STT_URL'),
      apiKey: opts.apiKey,
      authHeader: opts.authHeader,
      headers: opts.headers,
    });
    this.#opts = {
      vad: opts.vad,
      url: client.url,
      model,
      headers: client.headers,
      language,
      maxBufferedAudio,
      webSocketFactory:
        opts.webSocketFactory ?? ((socketUrl, options) => new WebSocket(socketUrl, options)),
    };
  }

  override get model(): string {
    return this.#opts.model;
  }

  override get provider(): string {
    return 'Microsoft AI';
  }

  protected override async _recognize(_buffer: AudioBuffer): Promise<stt.SpeechEvent> {
    throw new APIError('Microsoft AI STT supports stream(), not batch recognize()', {
      retryable: false,
    });
  }

  override stream(options: SpeechStreamOptions = {}): stt.SpeechStream {
    if (this.#closed) throw new Error('Microsoft AI STT is closed');
    const connOptions = options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
    if (!Number.isFinite(connOptions.timeoutMs) || connOptions.timeoutMs <= 0) {
      throw new Error('connOptions.timeoutMs must be finite and greater than zero');
    }
    const language = options.language ?? this.#opts.language;
    if (language !== undefined && !language.trim()) {
      throw new Error('language must be nonempty when supplied');
    }
    const stream = new SpeechStream(this, this.#opts, language, connOptions, () => {
      this.#streams.delete(stream);
    });
    this.#streams.add(stream);
    return stream;
  }

  override async close(): Promise<void> {
    this.#closed = true;
    for (const stream of this.#streams) stream.close();
    this.#streams.clear();
  }
}

/** A Microsoft AI native realtime transcription stream. */
class SpeechStream extends stt.SpeechStream {
  readonly #onDone: () => void;
  readonly #opts: ResolvedOptions;
  readonly #languageHint?: string;
  readonly #connOptions: APIConnectOptions;
  #inputSampleRate?: number;
  #inputDurationMs = 0;
  #processedSamples = 0;
  #segmentSamples = 0;
  #queuedItems = 0;
  #inputConsumed = false;
  #inputError?: APIError;
  #speaking = false;
  #item?: ItemState;
  #commit?: { promise: Promise<void>; resolve: () => void };
  #committedItemId?: string;
  readonly #finishedItems = new Set<string>();
  readonly #finishedItemOrder: string[] = [];
  readonly #eventIds = new Set<string>();
  readonly #eventIdOrder: string[] = [];
  #ws?: WebSocket;
  label = 'microsoft.SpeechStream';

  constructor(
    provider: STT,
    opts: ResolvedOptions,
    language: string | undefined,
    connOptions: APIConnectOptions,
    onDone: () => void,
  ) {
    super(provider, undefined, { ...connOptions, maxRetry: 0 });
    this.#onDone = onDone;
    this.#opts = opts;
    this.#languageHint = language;
    this.#connOptions = connOptions;
  }

  /** Number of resampled input samples fully consumed by the sender/VAD. */
  get processedSamples(): number {
    return this.#processedSamples;
  }

  override pushFrame(frame: AudioFrame): void {
    if (this.input.closed) throw new Error('Input is closed');
    if (this.closed) throw new Error('Stream is closed');
    if (frame.channels !== CHANNELS) throw new Error('Microsoft AI STT requires mono audio');
    if (frame.samplesPerChannel <= 0 || frame.sampleRate <= 0) {
      throw new Error('Microsoft AI STT requires nonempty audio frames');
    }
    if (this.#inputSampleRate !== undefined && frame.sampleRate !== this.#inputSampleRate) {
      throw new Error('Microsoft AI STT input sample rate cannot change within a stream');
    }
    const durationMs = (frame.samplesPerChannel / frame.sampleRate) * 1000;
    const bufferedMs = this.#inputDurationMs - (this.#processedSamples / SAMPLE_RATE) * 1000;
    if (
      bufferedMs + durationMs > this.#opts.maxBufferedAudio ||
      this.#queuedItems >= MAX_INPUT_ITEMS
    ) {
      const error = new APIConnectionError({
        message: 'Microsoft AI STT audio buffer is full; pace input or raise maxBufferedAudio',
        options: { retryable: false },
      });
      this.#failInput(error);
      throw error;
    }
    this.#inputSampleRate = frame.sampleRate;
    this.#inputDurationMs += durationMs;
    if (frame.sampleRate !== SAMPLE_RATE) {
      this.resampler ??= new AudioResampler(frame.sampleRate, SAMPLE_RATE);
      for (const output of this.resampler.push(frame)) this.#putInput(output);
    } else {
      this.#putInput(frame);
    }
  }

  override flush(): void {
    if (this.input.closed) throw new Error('Input is closed');
    if (this.closed) throw new Error('Stream is closed');
    this.#flushResampler();
    this.#putInput(SpeechStream.FLUSH_SENTINEL);
    this.#inputSampleRate = undefined;
  }

  override endInput(): void {
    if (this.input.closed) throw new Error('Input is closed');
    if (this.closed) throw new Error('Stream is closed');
    this.#flushResampler();
    this.input.close();
  }

  #putInput(item: AudioFrame | typeof SpeechStream.FLUSH_SENTINEL): void {
    if (this.#queuedItems >= MAX_INPUT_ITEMS) {
      const error = new APIConnectionError({
        message: 'Microsoft AI STT audio buffer is full; pace input or raise maxBufferedAudio',
        options: { retryable: false },
      });
      this.#failInput(error);
      throw error;
    }
    this.input.put(item);
    this.#queuedItems++;
  }

  #flushResampler(): void {
    if (!this.resampler) return;
    const resampler = this.resampler;
    this.resampler = undefined;
    for (const frame of resampler.flush()) this.#putInput(frame);
    resampler.close();
  }

  #failInput(error: APIError): void {
    this.#inputError = error;
    if (!this.input.closed) this.input.close();
  }

  protected override async run(): Promise<void> {
    try {
      for (let attempt = 0; attempt <= this.#connOptions.maxRetry; attempt++) {
        try {
          if (this.abortSignal.aborted) return;
          if (this.#inputError) throw this.#inputError;
          await this.#attempt();
          return;
        } catch (error) {
          if (this.abortSignal.aborted) return;
          let apiError =
            error instanceof APIError ? error : sanitizedConnectionError(this.#inputConsumed);
          if (this.#inputConsumed && apiError.retryable) {
            apiError = asNonRetryable(apiError);
          }
          if (!apiError.retryable || attempt === this.#connOptions.maxRetry) throw apiError;
          const delay = intervalForRetry(this.#connOptions, attempt);
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    } finally {
      this.#onDone();
    }
  }

  async #attempt(): Promise<void> {
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort(this.abortSignal.reason);
    if (this.abortSignal.aborted) attempt.abort(this.abortSignal.reason);
    else this.abortSignal.addEventListener('abort', abortAttempt, { once: true });
    let sender: Promise<void> | undefined;
    let receiver: Promise<void> | undefined;
    try {
      const { ws, inbox } = await this.#handshake(attempt.signal);
      this.#ws = ws;
      sender = this.#send(ws, attempt.signal);
      receiver = this.#receive(inbox, attempt.signal);
      const first = await Promise.race([
        sender.then(
          () => ({ task: 'sender' as const }),
          (error: unknown) => ({ task: 'sender' as const, error }),
        ),
        receiver.then(
          () => ({ task: 'receiver' as const }),
          (error: unknown) => ({ task: 'receiver' as const, error }),
        ),
      ]);
      if ('error' in first) throw first.error;
      if (first.task === 'receiver') {
        throw new APIConnectionError({
          message: 'Microsoft AI STT receiver stopped unexpectedly',
          options: { retryable: !this.#inputConsumed },
        });
      }
    } finally {
      this.abortSignal.removeEventListener('abort', abortAttempt);
      attempt.abort();
      this.#commit = undefined;
      const ws = this.#ws;
      this.#ws = undefined;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch {
          // The transport may already be closed.
        }
      }
      await Promise.allSettled([sender, receiver].filter((task): task is Promise<void> => !!task));
    }
  }

  async #handshake(signal: AbortSignal): Promise<{ ws: WebSocket; inbox: WebSocketInbox }> {
    signal.throwIfAborted();
    let ws: WebSocket;
    try {
      ws = this.#opts.webSocketFactory(this.#opts.url, {
        headers: this.#opts.headers,
        handshakeTimeout: this.#connOptions.timeoutMs,
        maxPayload: 1024 * 1024,
      });
    } catch {
      throw sanitizedConnectionError(false);
    }
    this.#ws = ws;
    const inbox = new WebSocketInbox(ws);
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            ws.off('open', onOpen);
            ws.off('unexpected-response', onUnexpectedResponse);
            ws.off('error', onError);
            ws.off('close', onClose);
            signal.removeEventListener('abort', onAbort);
          };
          const onOpen = () => {
            cleanup();
            resolve();
          };
          const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
            cleanup();
            reject(statusError('STT', response.statusCode ?? -1));
          };
          const onError = () => {
            cleanup();
            reject(sanitizedConnectionError(false));
          };
          const onClose = () => {
            cleanup();
            reject(sanitizedConnectionError(false));
          };
          const onAbort = () => {
            cleanup();
            reject(signal.reason);
          };
          ws.once('open', onOpen);
          ws.once('unexpected-response', onUnexpectedResponse);
          ws.once('error', onError);
          ws.once('close', onClose);
          signal.addEventListener('abort', onAbort, { once: true });
          if (ws.readyState === WebSocket.OPEN) onOpen();
        }),
        this.#connOptions.timeoutMs,
        true,
      );
      const created = await withTimeout(
        this.#receiveEvent(inbox, signal),
        this.#connOptions.timeoutMs,
        true,
      );
      if (created.type !== 'session.created') {
        throw new APIError('Microsoft AI STT expected session.created', { retryable: false });
      }
      await this.#write(ws, sessionUpdate(this.#opts.model, this.#languageHint), true);
      const updated = await withTimeout(
        this.#receiveEvent(inbox, signal),
        this.#connOptions.timeoutMs,
        true,
      );
      if (updated.type !== 'session.updated') {
        throw new APIError('Microsoft AI STT expected session.updated', { retryable: false });
      }
      return { ws, inbox };
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      throw error;
    }
  }

  async #receiveEvent(
    inbox: WebSocketInbox,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const incoming = await inbox.next(signal);
    if (incoming.kind === 'close') {
      throw new APIConnectionError({
        message: 'Microsoft AI STT connection closed unexpectedly',
        options: { retryable: !this.#inputConsumed },
      });
    }
    if (incoming.kind === 'error') throw sanitizedConnectionError(this.#inputConsumed);
    if (incoming.isBinary) {
      throw new APIError('Microsoft AI STT expected a JSON text event', { retryable: false });
    }
    let event: unknown;
    try {
      event = JSON.parse(incoming.data.toString());
    } catch {
      throw new APIError('Microsoft AI STT sent malformed JSON', { retryable: false });
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new APIError('Microsoft AI STT sent an invalid event', { retryable: false });
    }
    const record = event as Record<string, unknown>;
    if (typeof record.type !== 'string') {
      throw new APIError('Microsoft AI STT sent an invalid event', { retryable: false });
    }
    if (record.type === 'error' || record.type === `${TRANSCRIPTION}failed`) {
      throw providerError(record);
    }
    return record;
  }

  async #write(ws: WebSocket, event: Record<string, unknown>, retryable = false): Promise<void> {
    const operation = new Promise<void>((resolve, reject) => {
      try {
        ws.send(JSON.stringify(event), (error) => (error ? reject(error) : resolve()));
      } catch (error) {
        reject(error);
      }
    }).catch(() => {
      throw new APIConnectionError({
        message: 'Microsoft AI STT transport failed',
        options: { retryable },
      });
    });
    await withTimeout(operation, this.#connOptions.timeoutMs, retryable);
  }

  async #append(ws: WebSocket, frame: AudioFrame, accountInput = true): Promise<void> {
    await this.#write(ws, {
      type: 'input_audio_buffer.append',
      audio: bytes(frame).toString('base64'),
    });
    if (accountInput) this.#processedSamples += frame.samplesPerChannel;
    this.#segmentSamples += frame.samplesPerChannel;
  }

  async #commitAudio(ws: WebSocket, stream: AudioByteStream): Promise<void> {
    for (const frame of stream.flush()) await this.#append(ws, frame);
    if (this.#segmentSamples === 0) return;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    this.#commit = { promise, resolve };
    this.#committedItemId = undefined;
    try {
      await this.#write(ws, { type: 'input_audio_buffer.commit' });
      await withTimeout(promise, this.#connOptions.timeoutMs, false);
      this.#segmentSamples = 0;
    } finally {
      this.#commit = undefined;
    }
  }

  async #send(ws: WebSocket, signal: AbortSignal): Promise<void> {
    const stream = new AudioByteStream(SAMPLE_RATE, CHANNELS, CHUNK_SAMPLES);
    if (this.#opts.vad === null) {
      while (true) {
        let result: IteratorResult<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL>;
        try {
          result = await this.input.next({ signal });
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        }
        if (result.done) break;
        const item = result.value;
        this.#queuedItems--;
        if (this.#inputError) throw this.#inputError;
        if (item === SpeechStream.FLUSH_SENTINEL) {
          await this.#commitAudio(ws, stream);
          continue;
        }
        this.#inputConsumed = true;
        for (const frame of stream.write(item.data)) await this.#append(ws, frame);
      }
      if (this.#inputError) throw this.#inputError;
      await this.#commitAudio(ws, stream);
      return;
    }

    while (true) {
      const ended = await this.#sendVadSegment(ws, stream, this.#opts.vad, signal);
      if (ended) return;
    }
  }

  async #sendVadSegment(
    ws: WebSocket,
    stream: AudioByteStream,
    detector: VAD,
    signal: AbortSignal,
  ): Promise<boolean> {
    const vadStream = detector.stream();
    const segmentAbort = new AbortController();
    let vadClosed = false;
    let consumeCompleted = false;
    const closeVad = () => {
      if (vadClosed) return;
      vadClosed = true;
      vadStream.close();
    };
    const abortSegment = () => {
      segmentAbort.abort(signal.reason);
      closeVad();
    };
    signal.addEventListener('abort', abortSegment, { once: true });
    let pending = Buffer.alloc(0);
    let consumedSamples = 0;
    let fedSamples = 0;
    let feedEnded = false;
    let inputEnded = false;
    let speaking = false;
    let committedSamples = 0;

    const feed = async () => {
      while (true) {
        let result: IteratorResult<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL>;
        try {
          result = await this.input.next({ signal: segmentAbort.signal });
        } catch (error) {
          if (segmentAbort.signal.aborted) return;
          throw error;
        }
        if (result.done) break;
        const item = result.value;
        this.#queuedItems--;
        if (this.#inputError) throw this.#inputError;
        if (item === SpeechStream.FLUSH_SENTINEL) break;
        this.#inputConsumed = true;
        pending = Buffer.concat([pending, bytes(item)]);
        fedSamples += item.samplesPerChannel;
        vadStream.pushFrame(item);
      }
      if (this.#inputError) throw this.#inputError;
      inputEnded = this.input.closed;
      feedEnded = true;
      vadStream.endInput();
    };

    const drain = async (position: number) => {
      if (!Number.isInteger(position) || position < consumedSamples || position > fedSamples) {
        throw new APIError('Microsoft AI STT requires ordered, input-relative VAD timestamps', {
          retryable: false,
        });
      }
      const size = (position - consumedSamples) * 2;
      const data = speaking ? pending.subarray(0, size) : Buffer.alloc(0);
      pending = pending.subarray(size);
      consumedSamples = position;
      if (speaking) {
        for (const frame of stream.write(data)) await this.#append(ws, frame);
      } else {
        this.#processedSamples += size / 2;
      }
    };

    const sendPrefix = async (event: { frames: AudioFrame[] }, position: number) => {
      if (
        event.frames.length === 0 ||
        event.frames.some(
          (frame) =>
            frame.sampleRate !== SAMPLE_RATE ||
            frame.channels !== CHANNELS ||
            frame.samplesPerChannel <= 0,
        )
      ) {
        throw new APIError(
          'Microsoft AI STT requires nonempty mono 16kHz VAD start frames ending at the ' +
            'event timestamp to preserve the speech prefix',
          { retryable: false },
        );
      }
      const samples = event.frames.reduce((sum, frame) => sum + frame.samplesPerChannel, 0);
      if (samples > Math.floor((this.#opts.maxBufferedAudio / 1000) * SAMPLE_RATE)) {
        throw new APIError('Microsoft AI STT VAD start prefix exceeds maxBufferedAudio', {
          retryable: false,
        });
      }
      if (samples > position || position <= committedSamples) {
        throw new APIError('Microsoft AI STT received invalid VAD start timing', {
          retryable: false,
        });
      }
      const prefix = Buffer.concat(event.frames.map(bytes));
      const overlap = Math.max(0, committedSamples - (position - samples));
      for (const frame of stream.write(prefix.subarray(overlap * 2))) {
        await this.#append(ws, frame, false);
      }
      for (const frame of stream.flush()) await this.#append(ws, frame, false);
    };

    const consume = async () => {
      for await (const event of vadStream) {
        const position = event.samplesIndex;
        await drain(position);
        if (event.type === VADEventType.START_OF_SPEECH) {
          if (speaking) {
            throw new APIError('Microsoft AI STT received overlapping VAD speech starts', {
              retryable: false,
            });
          }
          await sendPrefix(event, position);
          speaking = true;
          this.#startSpeaking();
        } else if (event.type === VADEventType.END_OF_SPEECH) {
          if (!speaking) {
            throw new APIError('Microsoft AI STT received a VAD end without a speech start', {
              retryable: false,
            });
          }
          await this.#commitAudio(ws, stream);
          committedSamples = position;
          speaking = false;
        }
      }
      if (!feedEnded) {
        throw new APIError('Microsoft AI STT VAD stopped before end of input', {
          retryable: false,
        });
      }
      await drain(fedSamples);
      if (speaking) await this.#commitAudio(ws, stream);
      consumeCompleted = true;
    };

    const producer = feed();
    const consumer = consume();
    try {
      const first = await Promise.race([
        producer.then(
          () => ({ task: 'producer' as const }),
          (error: unknown) => ({ task: 'producer' as const, error }),
        ),
        consumer.then(
          () => ({ task: 'consumer' as const }),
          (error: unknown) => ({ task: 'consumer' as const, error }),
        ),
      ]);
      if ('error' in first) throw first.error;
      if (first.task === 'consumer') return inputEnded;
      await withTimeout(consumer, this.#connOptions.timeoutMs, false);
      return inputEnded;
    } finally {
      signal.removeEventListener('abort', abortSegment);
      segmentAbort.abort();
      if (!consumeCompleted) closeVad();
      await Promise.allSettled([producer, consumer]);
    }
  }

  async #receive(inbox: WebSocketInbox, signal: AbortSignal): Promise<void> {
    while (true) {
      const event = await this.#receiveEvent(inbox, signal);
      if (event.event_id !== undefined) {
        const eventId = stringField(event, 'event_id', true);
        if (this.#eventIds.has(eventId)) continue;
        this.#remember(this.#eventIds, this.#eventIdOrder, eventId, 256);
      }
      const eventType = event.type as string;
      if (!eventType.startsWith(TRANSCRIPTION) && eventType !== 'input_audio_buffer.committed') {
        continue;
      }
      const itemId = stringField(event, 'item_id', true);
      if (this.#finishedItems.has(itemId)) continue;
      this.#item ??= { id: itemId, finalized: '', hypothesis: '', lastInterim: '' };
      const item = this.#item;
      if (item.id !== itemId) {
        throw new APIError('Microsoft AI STT changed item before completion', {
          retryable: false,
        });
      }
      if (eventType === 'input_audio_buffer.committed') {
        if (!this.#commit) {
          throw new APIError('Microsoft AI STT acknowledged an unsolicited commit', {
            retryable: false,
          });
        }
        this.#committedItemId = itemId;
      } else if (eventType === `${TRANSCRIPTION}intermediate`) {
        item.hypothesis = stringField(event, 'intermediate');
        this.#interim(item);
      } else if (eventType === `${TRANSCRIPTION}delta`) {
        item.finalized += stringField(event, 'delta');
        item.hypothesis = '';
        this.#interim(item);
      } else if (eventType === `${TRANSCRIPTION}completed`) {
        this.#complete(item, stringField(event, 'transcript'));
      } else {
        throw new APIError('Microsoft AI STT sent an unsupported transcription event', {
          retryable: false,
        });
      }
    }
  }

  #interim(item: ItemState): void {
    const text = item.finalized + item.hypothesis;
    if (text.length > MAX_TEXT_LENGTH) {
      throw new APIError('Microsoft AI STT transcript exceeds the text limit', {
        retryable: false,
      });
    }
    if (text === item.lastInterim) return;
    item.lastInterim = text;
    this.#speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, item, text);
  }

  #complete(item: ItemState, transcript: string): void {
    if (!this.#commit || this.#committedItemId !== item.id) {
      throw new APIError('Microsoft AI STT completed without an acknowledged commit', {
        retryable: false,
      });
    }
    if (transcript) this.#speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, item, transcript);
    this.queue.put({
      type: stt.SpeechEventType.RECOGNITION_USAGE,
      requestId: item.id,
      recognitionUsage: { audioDuration: this.#segmentSamples / SAMPLE_RATE },
    });
    if (this.#speaking) {
      this.#speaking = false;
      this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH, requestId: item.id });
    }
    this.#remember(this.#finishedItems, this.#finishedItemOrder, item.id, 128);
    this.#item = undefined;
    this.#commit.resolve();
  }

  #startSpeaking(): void {
    if (this.#speaking) return;
    this.#speaking = true;
    this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
  }

  #speechEvent(type: stt.SpeechEventType, item: ItemState, text: string): void {
    this.#startSpeaking();
    this.queue.put({
      type,
      requestId: item.id,
      alternatives: [
        {
          language: normalizeLanguage(this.#languageHint ?? ''),
          text,
          startTime: 0,
          endTime: 0,
          confidence: 0,
        },
      ],
    });
  }

  #remember(set: Set<string>, order: string[], value: string, limit: number): void {
    if (set.has(value)) return;
    if (order.length >= limit) set.delete(order.shift()!);
    order.push(value);
    set.add(value);
  }

  override close(): void {
    const ws = this.#ws;
    if (ws) {
      try {
        ws.terminate();
      } catch {
        // The transport may already be closed.
      }
    }
    super.close();
    this.#onDone();
  }
}
