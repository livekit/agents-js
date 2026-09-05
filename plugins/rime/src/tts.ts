// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
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
  Future,
  type TimedString,
  asError,
  createTimedString,
  log,
  shortuuid,
  stream,
  tokenize,
  tts,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { type RawData, WebSocket } from 'ws';
import type { DefaultLanguages, TTSModels } from './models.js';

const RIME_BASE_URL = 'https://users.rime.ai/v1/rime-tts';
const RIME_WS_BASE_URL = 'wss://users-ws.rime.ai';
const RIME_TTS_SAMPLE_RATE = 24000;
const RIME_TTS_CHANNELS = 1;

/**
 * Get the appropriate sample rate based on TTS options.
 *
 * @param opts - Optional TTS configuration options
 * @returns The sample rate in Hz. Returns the explicit samplingRate if provided,
 *          otherwise returns model-specific defaults (24000 for coda, 16000 for mistv2,
 *          or the default RIME_TTS_SAMPLE_RATE for other models)
 */
function getSampleRate(opts?: Partial<TTSOptions>): number {
  if (opts?.samplingRate && typeof opts.samplingRate === 'number') {
    return opts.samplingRate;
  }
  switch (opts?.modelId) {
    case 'coda':
      return 24000;
    case 'mistv2':
      return 16000;
    default:
      return RIME_TTS_SAMPLE_RATE;
  }
}

/** Configuration options for Rime AI TTS */
export interface TTSOptions {
  speaker: string;
  modelId: TTSModels | string;
  baseURL?: string;
  apiKey?: string;
  useWebsocket?: boolean;
  segment?: string;
  /**
   * Reuse a successfully completed WebSocket for later speech streams.
   * Requires `useWebsocket: true` and `segment: 'never'`. Concurrent streams
   * have separate connections; at most one idle connection is kept for 30 seconds.
   * Call {@link TTS.close} when the provider is no longer needed.
   * @defaultValue false
   */
  reuseWebsocket?: boolean;
  /**
   * Flush each sentence emitted by the configured tokenizer to Rime without
   * waiting for input to end. Requires `useWebsocket: true` and `segment: 'never'`.
   * Synthesis batches run sequentially so Rime cannot coalesce overlapping flushes.
   * Tokenizer buffering still determines when a sentence is available.
   * @defaultValue false
   */
  flushSentences?: boolean;
  tokenizer?: tokenize.SentenceTokenizer;
  lang?: DefaultLanguages | string;
  repetition_penalty?: number;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  samplingRate?: number;
  timeScaleFactor?: number;
  speedAlpha?: number;
  reduceLatency?: boolean;
  pauseBetweenBrackets?: boolean;
  phonemizeBetweenBrackets?: boolean;
  inlineSpeedAlpha?: string;
  noTextNormalization?: boolean;
  saveOovs?: boolean;
  /** Additional Rime API parameters */
  [key: string]: string | number | boolean | tokenize.SentenceTokenizer | undefined;
}

const defaultTTSOptions: TTSOptions = {
  modelId: 'coda',
  speaker: 'luna',
  apiKey: process.env.RIME_API_KEY,
  baseURL: RIME_BASE_URL,
  useWebsocket: false,
  segment: 'bySentence',
};

function warnIfArcana(modelId: TTSOptions['modelId'] | undefined): void {
  if (modelId === 'arcana') {
    log().warn("Rime Arcana is no longer supported. Use modelId: 'coda' instead.");
  }
}

function modelParams(opts: TTSOptions): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  if (opts.lang !== undefined) params.lang = opts.lang;

  if (opts.modelId === 'coda') {
    if (opts.repetition_penalty !== undefined) params.repetition_penalty = opts.repetition_penalty;
    if (opts.temperature !== undefined) params.temperature = opts.temperature;
    if (opts.top_p !== undefined) params.top_p = opts.top_p;
    if (opts.max_tokens !== undefined) params.max_tokens = opts.max_tokens;
    if (opts.timeScaleFactor !== undefined) params.timeScaleFactor = opts.timeScaleFactor;
  } else if (opts.modelId.includes('mist')) {
    if (opts.speedAlpha !== undefined) params.speedAlpha = opts.speedAlpha;
    if (opts.pauseBetweenBrackets !== undefined) {
      params.pauseBetweenBrackets = opts.pauseBetweenBrackets;
    }
    if (opts.phonemizeBetweenBrackets !== undefined) {
      params.phonemizeBetweenBrackets = opts.phonemizeBetweenBrackets;
    }
    if (opts.modelId !== 'mistv2' && opts.timeScaleFactor !== undefined) {
      params.timeScaleFactor = opts.timeScaleFactor;
    }
  }

  return params;
}

function fetchPayload(opts: TTSOptions, text: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    speaker: opts.speaker,
    text,
    modelId: opts.modelId,
    ...modelParams(opts),
  };

  if (opts.samplingRate !== undefined) payload.samplingRate = opts.samplingRate;
  if (opts.modelId === 'mistv2' && opts.reduceLatency !== undefined) {
    payload.reduceLatency = opts.reduceLatency;
  }

  for (const [key, value] of Object.entries(opts)) {
    if (
      value === undefined ||
      [
        'apiKey',
        'baseURL',
        'useWebsocket',
        'segment',
        'tokenizer',
        'reuseWebsocket',
        'flushSentences',
        'speaker',
        'modelId',
        'lang',
        'repetition_penalty',
        'temperature',
        'top_p',
        'max_tokens',
        'samplingRate',
        'timeScaleFactor',
        'speedAlpha',
        'pauseBetweenBrackets',
        'phonemizeBetweenBrackets',
        'reduceLatency',
      ].includes(key)
    ) {
      continue;
    }
    payload[key] = value;
  }

  return payload;
}

function wsUrl(opts: TTSOptions): string {
  const params = new URLSearchParams();
  const sampleRate = getSampleRate(opts);
  const query: Record<string, string | number | boolean> = {
    speaker: opts.speaker,
    modelId: opts.modelId,
    audioFormat: 'pcm',
    samplingRate: sampleRate,
    segment: opts.segment ?? 'bySentence',
    ...modelParams(opts),
  };

  for (const [key, value] of Object.entries(query)) {
    params.set(key, typeof value === 'boolean' ? String(value) : `${value}`);
  }

  return `${opts.baseURL}/ws3?${params.toString()}`;
}

function resolveOptions(opts: Partial<TTSOptions>): TTSOptions {
  const useWebsocket = Boolean(
    opts.useWebsocket || opts.baseURL?.startsWith('ws://') || opts.baseURL?.startsWith('wss://'),
  );
  const resolved = {
    ...defaultTTSOptions,
    ...opts,
    useWebsocket,
    baseURL: opts.baseURL ?? (useWebsocket ? RIME_WS_BASE_URL : RIME_BASE_URL),
  };

  if (opts.speaker === undefined && opts.modelId === 'coda') {
    resolved.speaker = 'lyra';
  }

  if (resolved.modelId === 'mistv2' && resolved.timeScaleFactor !== undefined) {
    throw new Error('timeScaleFactor is not supported by the mistv2 model; use mistv3 or coda.');
  }

  if (
    (resolved.reuseWebsocket || resolved.flushSentences) &&
    (!resolved.useWebsocket || resolved.segment !== 'never')
  ) {
    throw new Error('Rime sentence flushing and connection reuse require WebSocket segment=never');
  }

  return resolved;
}

const connectionPools = new WeakMap<TTS, RimeConnectionPool>();

export class TTS extends tts.TTS {
  private opts: TTSOptions;
  label = 'rime.TTS';
  private connectionPool = new RimeConnectionPool();

  /** Close active and idle WebSockets and cancel pending connections. */
  async close(): Promise<void> {
    this.connectionPool.close();
    await super.close();
  }

  /**
   * Create a new instance of Rime TTS.
   *
   * @remarks
   * `apiKey` must be set to your Rime AI API key, either using the argument or by setting the
   * `RIME_API_KEY` environmental variable.
   *
   * @param opts - Configuration options for the TTS instance
   */

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts = resolveOptions(opts);
    const sampleRate = getSampleRate(resolvedOpts);
    super(sampleRate, RIME_TTS_CHANNELS, {
      streaming: resolvedOpts.useWebsocket ?? false,
      alignedTranscript: resolvedOpts.useWebsocket ?? false,
    });

    this.opts = resolvedOpts;
    if (this.opts.apiKey === undefined) {
      throw new Error('RIME API key is required, whether as an argument or as $RIME_API_KEY');
    }
    connectionPools.set(this, this.connectionPool);
    warnIfArcana(opts.modelId);
  }

  get model(): string {
    return this.opts.modelId;
  }

  get provider(): string {
    return 'Rime';
  }

  /**
   * Update TTS options after initialization
   *
   * @param opts - Partial options to update
   */
  updateOptions(opts: Partial<TTSOptions>) {
    warnIfArcana(opts.modelId);
    const updated = resolveOptions({ ...this.opts, ...opts });
    if (wsUrl(updated) !== wsUrl(this.opts) || updated.apiKey !== this.opts.apiKey) {
      this.connectionPool.invalidate();
    }
    this.opts = updated;
  }

  /**
   * Synthesize text to audio using Rime AI TTS.
   *
   * @param text - Text to synthesize
   * @returns A chunked stream of synthesized audio
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    if (this.opts.useWebsocket) {
      throw new Error(
        'Rime TTS one-shot synthesize requires useWebsocket=false at construction time',
      );
    }
    return new ChunkedStream(this, text, { ...this.opts }, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    if (!this.opts.useWebsocket) {
      throw new Error('Rime TTS streaming requires useWebsocket=true at construction time');
    }
    return new SynthesizeStream(this, { ...this.opts }, options?.connOptions);
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'rime-tts.ChunkedStream';
  private opts: TTSOptions;
  private text: string;

  /**
   * Create a new ChunkedStream instance.
   *
   * @param tts - The parent TTS instance
   * @param text - Text to synthesize
   * @param opts - TTS configuration options
   * @param connOptions - API connection options
   * @param abortSignal - Abort signal for cancellation
   */
  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.text = text;
    this.opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const response = await fetch(`${this.opts.baseURL}`, {
      method: 'POST',
      headers: {
        Accept: 'audio/pcm',
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...fetchPayload(this.opts, this.text),
      }),
      signal: this.abortSignal,
    });

    if (!response.ok) {
      throw new Error(`Rime AI TTS request failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Rime AI TTS response has no body');
    }

    const sampleRate = getSampleRate(this.opts);
    const audioByteStream = new AudioByteStream(sampleRate, RIME_TTS_CHANNELS);
    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (segmentId: string, final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const frame of audioByteStream.write(value)) {
          sendLastFrame(requestId, false);
          lastFrame = frame;
        }
      }

      for (const frame of audioByteStream.flush()) {
        if (frame.samplesPerChannel === 0) continue;
        sendLastFrame(requestId, false);
        lastFrame = frame;
      }

      sendLastFrame(requestId, true);
    } finally {
      reader.releaseLock();
      this.queue.close();
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'rime-tts.SynthesizeStream';
  #opts: TTSOptions;
  #logger = log();
  #tokenizer: tokenize.SentenceStream;
  #provider: TTS;
  #leadingWhitespace = '';
  #segmentHasText = false;
  private connectionPool: RimeConnectionPool;

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#provider = tts;
    const pool = connectionPools.get(tts);
    if (!pool) throw new Error('Rime TTS connection pool is unavailable');
    this.connectionPool = pool;
    this.#opts = opts;
    this.#tokenizer = (opts.tokenizer ?? new tokenize.basic.SentenceTokenizer()).stream();
  }

  /**
   * Buffer leading whitespace so empty SDK segments do not consume speech metrics.
   * @deprecated Use `updateInputStream` instead.
   */
  override pushText(text: string): void {
    if (this.#opts.flushSentences || this.#opts.reuseWebsocket) {
      if (!this.#segmentHasText) {
        this.#leadingWhitespace += text;
        if (!this.#leadingWhitespace.trim()) return;
        text = this.#leadingWhitespace;
        this.#leadingWhitespace = '';
        this.#segmentHasText = true;
      }
    }
    super.pushText(text);
  }

  /** Finish the current SDK segment, discarding whitespace-only input. */
  override flush(): void {
    this.#leadingWhitespace = '';
    this.#segmentHasText = false;
    super.flush();
  }

  protected async run() {
    if (this.#opts.flushSentences || this.#opts.reuseWebsocket) {
      return this.runSentences();
    }
    const requestId = shortuuid();
    const contextId = shortuuid();
    const bstream = new AudioByteStream(getSampleRate(this.#opts), RIME_TTS_CHANNELS);
    const messageChannel = stream.createStreamChannel<Record<string, unknown>>();
    const errorFuture = new Future<Error>();
    const inputSentFuture = new Future<void>();
    let emptyInput = false;
    let ws: WebSocket | undefined;

    const inputTask = async () => {
      for await (const data of this.input) {
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          this.#tokenizer.flush();
          continue;
        }
        this.#tokenizer.pushText(data);
      }
      this.#tokenizer.endInput();
      this.#tokenizer.close();
    };

    const sendTask = async () => {
      let sentCount = 0;
      for await (const event of this.#tokenizer) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new APIConnectionError({ message: 'Rime WebSocket connection is closed' });
        }
        this.markStarted();
        ws.send(JSON.stringify({ text: `${event.token} `, contextId }));
        if (!inputSentFuture.done) inputSentFuture.resolve();
        sentCount += 1;
      }

      if (sentCount === 0) {
        emptyInput = true;
        if (!inputSentFuture.done) inputSentFuture.resolve();
        return;
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new APIConnectionError({ message: 'Rime WebSocket connection is closed' });
      }
      ws.send(JSON.stringify({ operation: 'flush', contextId }));
    };

    const recvTask = async () => {
      await inputSentFuture.await;
      if (emptyInput) return;

      let lastFrame: AudioFrame | undefined;
      let pendingTimedTranscripts: TimedString[] = [];
      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (!lastFrame || this.queue.closed) return;
        this.queue.put({
          requestId,
          segmentId,
          frame: lastFrame,
          final,
          timedTranscripts:
            pendingTimedTranscripts.length > 0 ? pendingTimedTranscripts : undefined,
        });
        lastFrame = undefined;
        pendingTimedTranscripts = [];
      };

      const reader = messageChannel.stream().getReader();
      try {
        while (!this.closed && !this.abortSignal.aborted) {
          const [result, socketError] = await Promise.race([
            reader.read().then((result) => [result, undefined] as const),
            errorFuture.await.then((error) => [undefined, error] as const),
          ]);
          if (socketError) throw socketError;
          if (!result || result.done) break;

          const data = result.value;
          const type = data.type;
          if (type === 'chunk') {
            const audioBuffer = Buffer.from(data.data as string, 'base64');
            const audioData = audioBuffer.buffer.slice(
              audioBuffer.byteOffset,
              audioBuffer.byteOffset + audioBuffer.byteLength,
            );
            for (const frame of bstream.write(audioData)) {
              sendLastFrame(contextId, false);
              lastFrame = frame;
            }
          } else if (type === 'timestamps') {
            const wordTimestamps = data.word_timestamps as Record<string, unknown> | undefined;
            const words = wordTimestamps?.words as string[] | undefined;
            const starts = wordTimestamps?.start as number[] | undefined;
            const ends = wordTimestamps?.end as number[] | undefined;
            if (words && starts && ends) {
              const count = Math.min(words.length, starts.length, ends.length);
              for (let i = 0; i < count; i += 1) {
                pendingTimedTranscripts.push(
                  createTimedString({
                    text: `${words[i]} `,
                    startTime: starts[i]!,
                    endTime: ends[i]!,
                  }),
                );
              }
            }
          } else if (type === 'done') {
            for (const frame of bstream.flush()) {
              sendLastFrame(contextId, false);
              lastFrame = frame;
            }
            sendLastFrame(contextId, true);
            break;
          } else if (type === 'error') {
            throw new APIError(`Rime ws error: ${String(data.message ?? '(no message)')}`);
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    const onMessage = (rawData: RawData) => {
      try {
        void messageChannel.write(JSON.parse(rawData.toString()));
      } catch (error) {
        this.#logger.warn({ error }, 'failed to parse Rime WebSocket message');
      }
    };
    const onClose = (code: number, reason: Buffer) => {
      if (!this.abortSignal.aborted) {
        errorFuture.resolve(
          new APIStatusError({
            message: `Rime ws closed unexpectedly: ${reason.toString()}`,
            options: { statusCode: code },
          }),
        );
      }
      void messageChannel.close();
    };
    const onError = (error: Error) => {
      errorFuture.resolve(error);
      void messageChannel.close();
    };

    try {
      ws = await connectRimeWebSocket({
        url: wsUrl(this.#opts),
        apiKey: this.#opts.apiKey!,
        timeoutMs: this.connOptions.timeoutMs,
        abortSignal: this.abortSignal,
      });
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);

      await Promise.all([inputTask(), sendTask(), recvTask()]);
    } catch (error) {
      if (this.abortSignal.aborted) return;
      if (error instanceof APIError) throw error;
      const err = asError(error);
      if (err.message.includes('timeout')) {
        throw new APITimeoutError({ message: `Rime WS error: ${err.message}` });
      }
      throw new APIConnectionError({ message: `Rime WS error: ${err.message}` });
    } finally {
      if (!inputSentFuture.done) inputSentFuture.resolve();
      void messageChannel.close();
      if (ws) {
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        closeRimeWebSocket(ws);
      }
    }
  }
  // /ws3 can coalesce overlapping flushes. Wait for each matching done before
  // sending the next sentence, and rebase synthesis-local timestamps onto PCM time.
  private async runSentences() {
    const requestId = shortuuid();
    let segmentId = '';
    const sampleRate = getSampleRate(this.#opts);
    const segments = new AsyncIterableQueue<tokenize.SentenceStream>();
    const tokenizers = new Set<tokenize.SentenceStream>([this.#tokenizer]);
    let inputTokenizer: tokenize.SentenceStream | undefined = this.#tokenizer;
    segments.put(this.#tokenizer);
    const messages = stream.createStreamChannel<Record<string, unknown>>();
    const reader = messages.stream().getReader();
    const failure = new Future<Error>();
    const fail = (message: string) => {
      if (!failure.done)
        failure.resolve(new APIConnectionError({ message, options: { retryable: false } }));
    };
    let lease: Awaited<ReturnType<RimeConnectionPool['acquire']>> | undefined;
    let complete = false;
    let activeContext: string | undefined;
    let totalSamples = 0;
    let lastFrame: AudioFrame | undefined;
    let pendingTranscripts: TimedString[] = [];
    const emitFrame = (final: boolean) => {
      if (!lastFrame || this.closed || this.abortSignal.aborted || this.queue.closed) return;
      this.queue.put({
        requestId,
        segmentId,
        frame: lastFrame,
        final,
        timedTranscripts: pendingTranscripts.length ? pendingTranscripts : undefined,
      });
      lastFrame = undefined;
      pendingTranscripts = [];
    };
    const emitAvailable = (frame: AudioFrame) => {
      emitFrame(false);
      const samples = frame.samplesPerChannel;
      if (samples > 1) {
        lastFrame = new AudioFrame(
          frame.data.slice(0, -1),
          sampleRate,
          RIME_TTS_CHANNELS,
          samples - 1,
        );
        emitFrame(false);
      }
      // Keep one real sample for the SDK final frame, never a whole audio chunk.
      lastFrame = new AudioFrame(frame.data.slice(-1), sampleRate, RIME_TTS_CHANNELS, 1);
    };
    const onMessage = (raw: RawData) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'error') {
          // Provider error text can echo input or credentials. Keep it out of logs.
          fail('Rime WebSocket synthesis failed');
        } else if (activeContext && data.contextId === activeContext) {
          void messages.write(data).catch(() => {});
        }
      } catch {
        fail('Rime WebSocket returned invalid JSON');
      }
    };
    const onClose = () => fail('Rime WebSocket closed before synthesis completed');
    const onError = () => fail('Rime WebSocket transport failed');
    const onAbort = () => {
      fail('Rime WebSocket synthesis cancelled');
      lease?.socket.terminate();
    };
    const inputTask = async () => {
      for await (const data of this.input) {
        if (this.abortSignal.aborted) break;
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          inputTokenizer?.endInput();
          inputTokenizer = undefined;
        } else if (data) {
          if (!inputTokenizer) {
            inputTokenizer = (
              this.#opts.tokenizer ?? new tokenize.basic.SentenceTokenizer()
            ).stream();
            tokenizers.add(inputTokenizer);
            segments.put(inputTokenizer);
          }
          inputTokenizer.pushText(data);
        }
      }
      inputTokenizer?.endInput();
      segments.close();
    };
    const synthesize = async (text: string) => {
      if (!text.trim()) return;
      if (this.abortSignal.aborted || lease!.socket.readyState !== WebSocket.OPEN) {
        throw new APIConnectionError({
          message: 'Rime WebSocket connection is closed',
          options: { retryable: false },
        });
      }
      activeContext = shortuuid();
      const contextId = activeContext;
      segmentId ||= contextId;
      this.noteProviderRequestId(contextId);
      const offset = totalSamples / sampleRate;
      const samplesBeforeSynthesis = totalSamples;
      const bytes = new AudioByteStream(sampleRate, RIME_TTS_CHANNELS);
      this.markStarted();
      lease!.socket.send(JSON.stringify({ text, contextId }));
      lease!.socket.send(JSON.stringify({ operation: 'flush', contextId }));
      let timer: NodeJS.Timeout | undefined;
      const armTimeout = () => {
        if (timer) clearTimeout(timer);
        if (this.connOptions.timeoutMs > 0)
          timer = setTimeout(
            () => fail('Rime WebSocket synthesis timed out'),
            this.connOptions.timeoutMs,
          );
      };
      armTimeout();
      try {
        while (true) {
          const event = await reader.read();
          if (event.done)
            throw new APIConnectionError({
              message: 'Rime WebSocket stream ended early',
              options: { retryable: false },
            });
          const data = event.value;
          if (data.contextId !== contextId) continue;
          armTimeout();
          if (data.type === 'chunk') {
            const audio = Buffer.from(data.data as string, 'base64');
            totalSamples += audio.byteLength / 2;
            for (const frame of bytes.write(audio)) emitAvailable(frame);
          } else if (data.type === 'timestamps') {
            const timestamps = data.word_timestamps as
              | { words?: string[]; start?: number[]; end?: number[] }
              | undefined;
            if (timestamps?.words && timestamps.start && timestamps.end) {
              const count = Math.min(
                timestamps.words.length,
                timestamps.start.length,
                timestamps.end.length,
              );
              for (let i = 0; i < count; i++)
                pendingTranscripts.push(
                  createTimedString({
                    text: `${timestamps.words[i]} `,
                    startTime: offset + timestamps.start[i]!,
                    endTime: offset + timestamps.end[i]!,
                  }),
                );
            }
          } else if (data.type === 'done') {
            if (totalSamples === samplesBeforeSynthesis) {
              throw new APIConnectionError({
                message: 'Rime WebSocket synthesis completed without audio',
                options: { retryable: false },
              });
            }
            for (const frame of bytes.flush()) {
              if (frame.samplesPerChannel > 0) emitAvailable(frame);
            }
            activeContext = undefined;
            return;
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const finishSegment = async () => {
      if (!lastFrame) return;
      const emitted = new Future<void>();
      const onMetrics = (event: { requestId: string }) => {
        if (event.requestId === requestId && !emitted.done) emitted.resolve();
      };
      this.#provider.on('metrics_collected', onMetrics);
      try {
        emitFrame(true);
        // markStarted is reset by the SDK metrics consumer, not queue.put.
        // Do not let a queued segment inherit the previous segment's timing.
        await Promise.race([
          emitted.await,
          failure.await.then((error) => {
            throw error;
          }),
        ]);
      } finally {
        this.#provider.off('metrics_collected', onMetrics);
      }
    };
    const synthesisTask = async () => {
      for await (const tokenizer of segments) {
        segmentId = '';
        totalSamples = 0;
        let bufferedText = '';
        for await (const event of tokenizer) {
          if (this.#opts.flushSentences) await synthesize(`${event.token} `);
          else bufferedText += `${event.token} `;
        }
        if (!this.#opts.flushSentences) await synthesize(bufferedText);
        await finishSegment();
        tokenizer.close();
        tokenizers.delete(tokenizer);
      }
      complete = true;
    };
    this.abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      lease = await this.connectionPool.acquire(
        this.#opts,
        this.connOptions.timeoutMs,
        this.abortSignal,
      );
      lease.socket.on('message', onMessage);
      lease.socket.on('error', onError);
      lease.socket.on('close', onClose);
      await Promise.race([
        Promise.all([inputTask(), synthesisTask()]),
        failure.await.then((error) => {
          throw error;
        }),
      ]);
    } catch (error) {
      if (!this.abortSignal.aborted) {
        if (error instanceof APIConnectionError && !error.retryable) throw error;
        // Do not replay partial audio through the SDK retry loop.
        throw new APIConnectionError({
          message: 'Rime WebSocket synthesis failed',
          options: { retryable: false },
        });
      }
    } finally {
      this.abortSignal.removeEventListener('abort', onAbort);
      for (const tokenizer of tokenizers) tokenizer.close();
      segments.close();
      if (!this.input.closed) this.input.close();
      await reader.cancel();
      reader.releaseLock();
      if (lease) {
        lease.socket.off('message', onMessage);
        lease.socket.off('error', onError);
        lease.socket.off('close', onClose);
        this.connectionPool.release(
          lease,
          Boolean(this.#opts.reuseWebsocket && complete && !this.abortSignal.aborted),
        );
      }
    }
  }
}

async function connectRimeWebSocket({
  url,
  apiKey,
  timeoutMs,
  abortSignal,
}: {
  url: string;
  apiKey: string;
  timeoutMs: number;
  abortSignal: AbortSignal;
}): Promise<WebSocket> {
  if (abortSignal.aborted) throw new Error('aborted');
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: timeoutMs,
  });
  const fut = new Future<void>();
  let timeout: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    ws.off('open', onOpen);
    ws.off('error', onError);
    ws.off('close', onClose);
    abortSignal.removeEventListener('abort', onAbort);
  };
  const onOpen = () => fut.resolve();
  const onError = (error: Error) => fut.reject(error);
  const onClose = (code: number, reason: Buffer) =>
    fut.reject(
      new Error(`WebSocket closed before open (code=${code}, reason=${reason.toString()})`),
    );
  const onAbort = () => fut.reject(new Error('aborted'));

  ws.on('open', onOpen);
  ws.on('error', onError);
  ws.on('close', onClose);
  abortSignal.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs > 0)
    timeout = setTimeout(() => fut.reject(new Error('connect timeout')), timeoutMs);

  try {
    await fut.await;
    return ws;
  } catch (error) {
    closeRimeWebSocket(ws);
    throw error;
  } finally {
    cleanup();
  }
}

function closeRimeWebSocket(ws: WebSocket) {
  try {
    ws.on('error', () => {});
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ operation: 'eos' }));
      ws.close();
    } else if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  } catch {
    // best-effort close
  }
}

// A socket is never shared by simultaneous contexts. Only fully drained leases return idle.
class RimeConnectionPool {
  private sockets = new Set<WebSocket>();
  private pending = new Set<AbortController>();
  private idle?: { socket: WebSocket; url: string; apiKey: string; timer: NodeJS.Timeout };
  private generation = 0;
  private closed = false;

  async acquire(opts: TTSOptions, timeoutMs: number, signal: AbortSignal) {
    if (this.closed || signal.aborted)
      throw new APIConnectionError({
        message: 'Rime connection closed',
        options: { retryable: false },
      });
    const url = wsUrl(opts);
    const generation = this.generation;
    if (this.idle) {
      const idle = this.idle;
      this.idle = undefined;
      clearTimeout(idle.timer);
      if (
        opts.reuseWebsocket &&
        idle.url === url &&
        idle.apiKey === opts.apiKey &&
        idle.socket.readyState === WebSocket.OPEN
      ) {
        return { socket: idle.socket, generation, url, apiKey: opts.apiKey! };
      }
      idle.socket.terminate();
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.pending.add(controller);
    try {
      const socket = await connectRimeWebSocket({
        url,
        apiKey: opts.apiKey!,
        timeoutMs,
        abortSignal: controller.signal,
      });
      // Own error events while idle and while a lease changes listeners.
      socket.on('error', () => {});
      socket.once('close', () => {
        this.sockets.delete(socket);
        if (this.idle?.socket === socket) {
          clearTimeout(this.idle.timer);
          this.idle = undefined;
        }
      });
      this.sockets.add(socket);
      if (this.closed || signal.aborted) {
        socket.terminate();
        throw new APIConnectionError({
          message: 'Rime connection closed',
          options: { retryable: false },
        });
      }
      return { socket, generation, url, apiKey: opts.apiKey! };
    } finally {
      this.pending.delete(controller);
      signal.removeEventListener('abort', abort);
    }
  }

  release(
    lease: { socket: WebSocket; generation: number; url: string; apiKey: string },
    reusable: boolean,
  ) {
    if (
      !reusable ||
      this.closed ||
      lease.generation !== this.generation ||
      this.idle ||
      lease.socket.readyState !== WebSocket.OPEN
    ) {
      lease.socket.terminate();
      return;
    }
    const timer = setTimeout(() => {
      if (this.idle?.socket === lease.socket) this.idle = undefined;
      lease.socket.terminate();
    }, 30_000);
    timer.unref();
    this.idle = { ...lease, timer };
  }

  invalidate() {
    this.generation += 1;
    if (this.idle) {
      clearTimeout(this.idle.timer);
      this.idle.socket.terminate();
      this.idle = undefined;
    }
  }

  close() {
    this.closed = true;
    this.invalidate();
    for (const controller of this.pending) controller.abort();
    for (const socket of this.sockets) socket.terminate();
  }
}
