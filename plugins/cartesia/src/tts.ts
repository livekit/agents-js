// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  ConnectionPool,
  Future,
  type TimedString,
  asError,
  createTimedString,
  getBaseLanguage,
  log,
  normalizeLanguage,
  shortuuid,
  stream,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { request } from 'node:https';
import { type RawData, WebSocket } from 'ws';
import {
  TTSDefaultVoiceId,
  type TTSEncoding,
  type TTSModels,
  type TTSVoiceEmotion,
  type TTSVoiceSpeed,
  isSonic3,
} from './models.js';
import {
  type CartesiaServerMessage,
  cartesiaMessageSchema,
  hasWordTimestamps,
  isChunkMessage,
  isDoneMessage,
  isErrorMessage,
  isFlushDoneMessage,
} from './types.js';

const AUTHORIZATION_HEADER = 'X-API-Key';
const VERSION_HEADER = 'Cartesia-Version';
const API_VERSION = '2025-04-16';
const API_VERSION_WITH_EXPERIMENTAL_CONTROLS = '2024-11-13';
const MODEL_WITH_EXPERIMENTAL_CONTROLS = 'sonic-2-2025-03-07';
const NUM_CHANNELS = 1;
const BUFFERED_WORDS_COUNT = 8;
// Cartesia refreshes a pooled socket after this long so a very long call cannot
// keep one connection open indefinitely. Matches the Python plugin's 300s.
const MAX_SESSION_DURATION_MS = 300_000;

// Lets each SynthesizeStream reach the pool owned by the TTS that created it,
// without widening the constructor signature the base class fixes.
const connectionPools = new WeakMap<TTS, ConnectionPool<WebSocket>>();

export interface TTSOptions {
  model: TTSModels | string;
  encoding: TTSEncoding;
  sampleRate: number;
  voice: string | number[];
  speed?: TTSVoiceSpeed | number;
  emotion?: (TTSVoiceEmotion | string)[];
  /**
   * Volume of the speech. For sonic-3, the value is valid between 0.5 and 2.0.
   * @see https://docs.cartesia.ai/api-reference/tts/bytes#body-generation-config-volume
   */
  volume?: number;
  apiKey?: string;
  language: string;
  baseUrl: string;
  apiVersion: string;

  /**
   * The timeout for the next chunk to be received from the Cartesia API.
   */
  chunkTimeout: number;

  /**
   * Whether to add word timestamps to the output. When enabled, the TTS will return
   * timing information for each word in the transcript.
   * @defaultValue true
   */
  wordTimestamps?: boolean;

  pronunciationDictId?: string;
}

const defaultTTSOptions: TTSOptions = {
  model: 'sonic-3',
  encoding: 'pcm_s16le',
  sampleRate: 24000,
  voice: TTSDefaultVoiceId,
  apiKey: process.env.CARTESIA_API_KEY,
  language: 'en',
  baseUrl: 'https://api.cartesia.ai',
  apiVersion: API_VERSION,
  chunkTimeout: 5000,
  wordTimestamps: true,
};

const checkGenerationConfig = (opts: TTSOptions) => {
  const logger = log();
  if (isSonic3(opts.model)) {
    if (opts.speed !== undefined && typeof opts.speed === 'number') {
      if (opts.speed < 0.6 || opts.speed > 2.0) {
        logger.warn('speed must be between 0.6 and 2.0 for sonic-3');
      }
    }
    if (opts.volume !== undefined && (opts.volume < 0.5 || opts.volume > 2.0)) {
      logger.warn('volume must be between 0.5 and 2.0 for sonic-3');
    }
  } else if (
    opts.apiVersion !== API_VERSION_WITH_EXPERIMENTAL_CONTROLS ||
    opts.model !== MODEL_WITH_EXPERIMENTAL_CONTROLS
  ) {
    if (opts.speed || opts.emotion) {
      logger.warn(
        { model: opts.model, speed: opts.speed, emotion: opts.emotion },
        `speed and emotion controls are only supported for model '${MODEL_WITH_EXPERIMENTAL_CONTROLS}' ` +
          `or sonic-3 models, see https://docs.cartesia.ai/developer-tools/changelog for details`,
      );
    }
  }

  if (opts.pronunciationDictId && !isSonic3(opts.model)) {
    logger.warn(
      { model: opts.model, pronunciationDictId: opts.pronunciationDictId },
      'pronunciationDictId is only supported for sonic-3 models',
    );
  }
};

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #pool: ConnectionPool<WebSocket>;
  #closed = false;
  label = 'cartesia.TTS';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Cartesia';
  }

  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts = {
      ...defaultTTSOptions,
      ...opts,
    };

    super(resolvedOpts.sampleRate || defaultTTSOptions.sampleRate, NUM_CHANNELS, {
      streaming: true,
      alignedTranscript: resolvedOpts.wordTimestamps ?? true,
    });

    this.#opts = resolvedOpts;
    this.#opts.language = normalizeLanguage(this.#opts.language);

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'Cartesia API key is required, whether as an argument or as $CARTESIA_API_KEY',
      );
    }

    if (
      this.#opts.speed ||
      this.#opts.emotion ||
      this.#opts.volume ||
      this.#opts.pronunciationDictId
    ) {
      checkGenerationConfig(this.#opts);
    }

    // One socket, reused across generations. Cartesia recommends a single
    // preconnected WebSocket for many generations because a fresh connection
    // repays TCP/TLS setup on every turn:
    // https://docs.cartesia.ai/use-the-api/compare-tts-endpoints
    this.#pool = new ConnectionPool<WebSocket>({
      connectCb: (timeoutMs) => this.#connectWebSocket(timeoutMs),
      closeCb: async (ws) => safeCloseWebSocket(ws),
      maxSessionDuration: MAX_SESSION_DURATION_MS,
      markRefreshedOnGet: true,
    });
    connectionPools.set(this, this.#pool);
  }

  updateOptions(opts: Partial<TTSOptions>) {
    // Only these three fields reach Cartesia at WebSocket-handshake time (auth
    // header, version header, host). Everything else (model, voice, encoding,
    // sample rate, speed, emotion, volume, language) is sent in-band on each
    // generation, so a pooled socket serves the new value without reconnecting.
    // Reconnect only when one of the handshake inputs actually changes.
    const handshakeChanged =
      (opts.apiKey !== undefined && opts.apiKey !== this.#opts.apiKey) ||
      (opts.apiVersion !== undefined && opts.apiVersion !== this.#opts.apiVersion) ||
      (opts.baseUrl !== undefined && opts.baseUrl !== this.#opts.baseUrl);

    this.#opts = { ...this.#opts, ...opts };
    if (opts.language !== undefined) {
      this.#opts.language = normalizeLanguage(opts.language);
    }

    if (
      this.#opts.speed ||
      this.#opts.emotion ||
      this.#opts.volume ||
      this.#opts.pronunciationDictId
    ) {
      checkGenerationConfig(this.#opts);
    }

    if (handshakeChanged) {
      this.#pool.invalidate();
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, { ...this.#opts }, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new SynthesizeStream(this, { ...this.#opts }, options?.connOptions);
  }

  /**
   * Open the pooled WebSocket ahead of the first generation so the first turn
   * does not pay the connect. Safe to call more than once; it is a no-op when a
   * connection already exists.
   */
  prewarm(): void {
    this.#pool.prewarm();
  }

  override async close(): Promise<void> {
    this.#closed = true;
    await this.#pool.close();
    await super.close();
  }

  async #connectWebSocket(timeoutMs: number): Promise<WebSocket> {
    // Snapshot the handshake inputs. If a concurrent updateOptions() changes one
    // of them while this connect is in flight, reconnect on the new value rather
    // than pooling a socket built on stale credentials (mirrors the fishaudio
    // plugin's model re-check).
    const apiKey = this.#opts.apiKey!;
    const apiVersion = this.#opts.apiVersion;
    const baseUrl = this.#opts.baseUrl;
    const url = `${baseUrl.replace(/^http/, 'ws')}/tts/websocket`;
    const ws = await connectCartesiaWebSocket({
      url,
      headers: {
        [AUTHORIZATION_HEADER]: apiKey,
        [VERSION_HEADER]: apiVersion,
      },
      timeoutMs,
    });
    if (this.#closed) {
      safeCloseWebSocket(ws);
      throw new APIConnectionError({ message: 'Cartesia TTS is closed' });
    }
    if (
      apiKey !== this.#opts.apiKey ||
      apiVersion !== this.#opts.apiVersion ||
      baseUrl !== this.#opts.baseUrl
    ) {
      safeCloseWebSocket(ws);
      return await this.#connectWebSocket(timeoutMs);
    }
    // Drop a socket that closes (or errors) while idle in the pool. Between turns
    // no generation listeners are attached, so without this the pool keeps a dead
    // socket in `available` and the next turn spends a retry to discard it, or
    // fails outright at maxRetry:0. A generation attaches its own listeners on top
    // of these; the no-op error listener also stops an idle 'error' from crashing
    // the process. Remove is a no-op once the socket is no longer pooled, so this
    // is safe during an active generation and during close().
    ws.on('error', () => {});
    ws.on('close', () => this.#pool.remove(ws));
    return ws;
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'cartesia.ChunkedStream';
  #logger = log();
  #opts: TTSOptions;
  #text: string;

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#text = text;
    this.#opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const json = toCartesiaOptions(this.#opts);
    json.transcript = this.#text;

    const baseUrl = new URL(this.#opts.baseUrl);
    const doneFut = new Future<void>();

    const req = request(
      {
        hostname: baseUrl.hostname,
        port: parseInt(baseUrl.port) || (baseUrl.protocol === 'https:' ? 443 : 80),
        path: '/tts/bytes',
        method: 'POST',
        headers: {
          [AUTHORIZATION_HEADER]: this.#opts.apiKey!,
          [VERSION_HEADER]: this.#opts.apiVersion,
        },
        signal: this.abortSignal,
      },
      (res) => {
        res.on('data', (chunk) => {
          for (const frame of bstream.write(chunk)) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
        });
        res.on('close', () => {
          for (const frame of bstream.flush()) {
            this.queue.put({
              requestId,
              frame,
              final: false,
              segmentId: requestId,
            });
          }
          this.queue.close();
          if (!doneFut.done) doneFut.resolve();
        });
        res.on('error', (err) => {
          if (err.message === 'aborted') return;
          this.#logger.error({ err }, 'Cartesia TTS response error');
          if (!doneFut.done) doneFut.reject(err);
        });
      },
    );

    req.on('error', (err) => {
      if (err.name === 'AbortError') return;
      this.#logger.error({ err }, 'Cartesia TTS request error');
      if (!doneFut.done) doneFut.reject(err);
    });
    req.on('close', () => {
      if (!doneFut.done) doneFut.resolve();
    });
    req.write(JSON.stringify(json));
    req.end();

    try {
      await doneFut.await;
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (!this.queue.closed) this.queue.close();
      throw toRetryableConnectionError(e);
    }
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  #pool: ConnectionPool<WebSocket>;
  #logger = log();
  #tokenizer = new tokenize.basic.SentenceTokenizer({
    minSentenceLength: BUFFERED_WORDS_COUNT,
  }).stream();
  label = 'cartesia.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    const pool = connectionPools.get(tts);
    if (!pool) throw new Error('Cartesia connection pool is not initialized');
    this.#pool = pool;
    this.#opts = opts;
  }

  updateOptions(opts: Partial<TTSOptions>) {
    this.#opts = { ...this.#opts, ...opts };

    if (
      this.#opts.speed ||
      this.#opts.emotion ||
      this.#opts.volume ||
      this.#opts.pronunciationDictId
    ) {
      checkGenerationConfig(this.#opts);
    }
  }

  protected async run() {
    const requestId = shortuuid();
    // Only finish the generation once both: 1) Cartesia returns done, AND 2) all sentences have been sent
    let sentenceStreamClosed = false;

    const sentenceStreamTask = async (ws: WebSocket) => {
      const packet = toCartesiaOptions(this.#opts, true);
      for await (const event of this.#tokenizer) {
        const msg = {
          ...packet,
          context_id: requestId,
          transcript: event.token + ' ',
          continue: true,
        };
        this.markStarted();
        ws.send(JSON.stringify(msg));
      }

      const endMsg = {
        ...packet,
        context_id: requestId,
        transcript: ' ',
        continue: false,
      };
      ws.send(JSON.stringify(endMsg));
      // Mark sentence stream as closed
      sentenceStreamClosed = true;
    };

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

    // Use event channel and set up listeners ONCE to avoid missing messages during listener re-registration
    const recvTask = async (ws: WebSocket) => {
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

      // Create event channel to buffer incoming messages
      // This prevents message loss between listener re-registrations
      const eventChannel = stream.createStreamChannel<RawData>();

      let lastFrame: AudioFrame | undefined;
      let pendingTimedTranscripts: TimedString[] = [];

      const sendLastFrame = (segmentId: string, final: boolean) => {
        if (lastFrame && !this.queue.closed) {
          // Include timedTranscripts with the audio frame
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
        }
      };

      let timeout: NodeJS.Timeout | null = null;
      // Set when the chunk watchdog fires: the socket is discarded, not pooled.
      let timedOut = false;
      // Set once this generation's `done` has been handled. Until then, a socket
      // close or error is a mid-generation drop, not a normal end.
      let completed = false;
      // A socket close/error before completion. Thrown after the loop so the turn
      // fails over (and the dead socket is discarded) instead of ending silently.
      let streamError: Error | undefined;

      const clearTTSChunkTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      // Set up WebSocket listeners ONCE (not in a loop)
      const onMessage = (data: RawData) => {
        void eventChannel.write(data).catch((error: unknown) => {
          this.#logger.debug({ error }, 'Failed writing Cartesia event to channel (likely closed)');
        });
      };

      const onClose = (code: number, reason: Buffer) => {
        // A close during an active generation is unexpected: the pool owns the
        // socket lifecycle and does not close it between turns. If it happens
        // before `done`, surface it so the turn retries rather than ending mid
        // speech, and so withConnection discards the dead socket.
        this.#logger.debug(`WebSocket closed with code ${code}: ${reason.toString()}`);
        clearTTSChunkTimeout();
        if (!completed && !timedOut && !streamError) {
          streamError = new APIConnectionError({
            message: `Cartesia WebSocket closed mid-generation (code=${code})`,
          });
        }
        void eventChannel.close();
      };

      const onError = (err: Error) => {
        this.#logger.error({ err }, 'Cartesia WebSocket error');
        if (!completed && !timedOut && !streamError) {
          streamError = err instanceof APIError ? err : toRetryableConnectionError(err);
        }
        void eventChannel.close();
      };

      // Attach listeners ONCE
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);

      try {
        // Process messages from the channel
        const reader = eventChannel.stream().getReader();

        while (!this.closed && !this.abortController.signal.aborted) {
          const result = await reader.read();
          if (result.done) break;

          const rawMsg = result.value;

          // Parse message with Zod schema for type safety
          let serverMsg: CartesiaServerMessage;
          try {
            const json = JSON.parse(rawMsg.toString());
            serverMsg = cartesiaMessageSchema.parse(json);
          } catch (parseErr) {
            this.#logger.warn({ parseErr }, 'Failed to parse Cartesia message');
            continue;
          }

          const segmentId = serverMsg.context_id;

          // Handle error frames first. 4xx (e.g. empty-transcript on
          // function-call turns) is non-fatal — log and fall through so an
          // accompanying done:true still triggers the unified close path
          // below. 5xx bubbles up so the base SynthesizeStream can retry.
          if (isErrorMessage(serverMsg)) {
            if (serverMsg.status_code >= 400 && serverMsg.status_code < 500) {
              this.#logger.debug({ error: serverMsg.error }, 'Cartesia sent a non-fatal error');
            } else {
              this.#logger.error({ error: serverMsg.error }, 'Cartesia returned error');
              throw new APIStatusError({
                message: `Cartesia returned error: ${serverMsg.error}`,
                options: { statusCode: serverMsg.status_code, retryable: true },
              });
            }
          }

          if (isChunkMessage(serverMsg)) {
            const audioBuffer = Buffer.from(serverMsg.data, 'base64');
            // Extract ArrayBuffer from Buffer for AudioByteStream compatibility
            const audioData = audioBuffer.buffer.slice(
              audioBuffer.byteOffset,
              audioBuffer.byteOffset + audioBuffer.byteLength,
            );
            for (const frame of bstream.write(audioData)) {
              sendLastFrame(segmentId, false);
              lastFrame = frame;
            }

            // IMPORTANT: close WS if TTS chunk stream been stuck too long
            // this allows unblock the current "broken" TTS node so that any future TTS nodes
            // can continue to process the stream without been blocked by the stuck node
            clearTTSChunkTimeout();
            timeout = setTimeout(() => {
              // cartesia chunk timeout quite often, so we make it a debug log
              this.#logger.debug(
                `Cartesia WebSocket TTS chunk stream timeout after ${this.#opts.chunkTimeout}ms`,
              );
              // The socket is stuck mid-generation, so it must not return to the
              // pool. Poison it and unblock the reader; the post-loop check turns
              // this into a retryable error so withConnection discards the socket.
              timedOut = true;
              safeCloseWebSocket(ws);
              void eventChannel.close();
            }, this.#opts.chunkTimeout);
          } else if (this.#opts.wordTimestamps !== false && hasWordTimestamps(serverMsg)) {
            const wordTimestamps = serverMsg.word_timestamps;
            for (let i = 0; i < wordTimestamps.words.length; i++) {
              const word = wordTimestamps.words[i];
              const startTime = wordTimestamps.start[i];
              const endTime = wordTimestamps.end[i];
              if (word !== undefined && startTime !== undefined && endTime !== undefined) {
                pendingTimedTranscripts.push(
                  createTimedString({
                    text: word + ' ', // Add space after word for consistency
                    startTime,
                    endTime,
                  }),
                );
              }
            }
          } else if (isDoneMessage(serverMsg) || (isErrorMessage(serverMsg) && serverMsg.done)) {
            // This ensures all sentences have been sent before closing
            if (sentenceStreamClosed) {
              for (const frame of bstream.flush()) {
                sendLastFrame(segmentId, false);
                lastFrame = frame;
              }
              sendLastFrame(segmentId, true);
              if (!this.queue.closed) {
                this.queue.put(SynthesizeStream.END_OF_STREAM);
              }

              if (segmentId === requestId) {
                clearTTSChunkTimeout();
                completed = true;
                // Leave the socket open so the pool reuses it on the next turn.
                break; // Exit the loop
              }
            }
            // If sentenceStreamClosed is false, continue receiving - more done messages will come
          } else if (!isFlushDoneMessage(serverMsg) && !isErrorMessage(serverMsg)) {
            // flush_done is an ack with nothing to do; error frames without
            // done:true were already logged above.
            this.#logger.warn({ message: serverMsg }, 'Unknown Cartesia message');
          }
        }

        if (timedOut) {
          throw new APITimeoutError({
            message: `Cartesia TTS chunk stream timed out after ${this.#opts.chunkTimeout}ms`,
          });
        }
        if (streamError) {
          throw streamError;
        }
      } catch (err) {
        // Always propagate API errors so the base SynthesizeStream can retry
        // and emit tts_error once retries are exhausted.
        if (err instanceof APIError) throw err;
        // skip log error for normal websocket close
        if (err instanceof Error && !err.message.includes('WebSocket closed')) {
          if (
            err.message.includes('Queue is closed') ||
            err.message.includes('Channel is closed')
          ) {
            this.#logger.warn(
              { err },
              'Channel closed during transcript processing (expected during disconnect)',
            );
          } else {
            this.#logger.error({ err }, 'Error in recvTask from Cartesia WebSocket');
          }
        }
      } finally {
        // IMPORTANT: Remove listeners so connection can be reused
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        clearTTSChunkTimeout();
      }
    };

    try {
      // The pool hands back one live socket per call and reclaims it on success
      // (put) or discards it on any thrown error (remove). A generation never
      // closes the socket itself, so the next turn skips the handshake.
      await this.#pool.withConnection(
        async (ws) => {
          if (ws.readyState !== WebSocket.OPEN) {
            throw new APIConnectionError({ message: 'Cartesia pooled websocket is not open' });
          }
          await Promise.all([inputTask(), sentenceStreamTask(ws), recvTask(ws)]);
        },
        { timeout: this.connOptions.timeoutMs, signal: this.abortSignal },
      );
    } catch (e) {
      if (this.abortSignal.aborted) {
        return;
      }
      if (e instanceof APIError) throw e;
      throw toRetryableConnectionError(e);
    }
  }
}

const transientNetworkCodes = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ECONNREFUSED',
  'EHOSTUNREACH',
]);

const isRecord = (v: unknown): v is Record<string, unknown> => {
  return v !== null && typeof v === 'object';
};

const isAggregateErrorLike = (e: unknown): e is { errors: unknown[]; name?: string } => {
  if (!isRecord(e)) return false;
  return e.name === 'AggregateError' && Array.isArray(e.errors);
};

const hasErrorCode = (e: unknown, code: string): boolean => {
  if (isRecord(e) && e.code === code) return true;
  if (isAggregateErrorLike(e)) {
    return e.errors.some((inner) => hasErrorCode(inner, code));
  }
  return false;
};

const hasAnyTransientCode = (e: unknown): boolean => {
  if (isRecord(e) && typeof e.code === 'string') {
    return transientNetworkCodes.has(e.code);
  }
  if (isAggregateErrorLike(e)) {
    return e.errors.some((inner) => hasAnyTransientCode(inner));
  }
  return false;
};

const toRetryableConnectionError = (e: unknown): APIConnectionError => {
  const err = asError(e);
  const isTimeout =
    hasErrorCode(e, 'ETIMEDOUT') ||
    (typeof err.message === 'string' && err.message.includes('ETIMEDOUT'));
  const message = isTimeout
    ? `Cartesia connection timed out`
    : `Cartesia connection failed: ${err.message || 'unknown error'}`;
  return isTimeout ? new APITimeoutError({ message }) : new APIConnectionError({ message });
};

const waitForWsOpen = async ({
  ws,
  timeoutMs,
  abortSignal,
}: {
  ws: WebSocket;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}) => {
  if (abortSignal?.aborted) {
    throw new Error('aborted');
  }

  const fut = new Future<void>();
  let timeout: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    ws.off('open', onOpen);
    ws.off('error', onError);
    ws.off('close', onClose);
    abortSignal?.removeEventListener('abort', onAbort);
  };

  const onOpen = () => fut.resolve();
  const onError = (err: Error) => fut.reject(asError(err));
  const onClose = (code: number, reason: Buffer) =>
    fut.reject(
      new Error(`WebSocket closed before open (code=${code}, reason=${reason.toString()})`),
    );
  const onAbort = () => fut.reject(new Error('aborted'));

  ws.on('open', onOpen);
  ws.on('error', onError);
  ws.on('close', onClose);
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  if (timeoutMs > 0) {
    timeout = setTimeout(() => fut.reject(new Error('connect timeout')), timeoutMs);
  }

  try {
    await fut.await;
  } finally {
    cleanup();
  }
};

const safeTerminateWebSocket = (ws: WebSocket) => {
  // `ws` can emit an 'error' event during teardown (especially if CONNECTING).
  // If there is no error listener at that moment, Node will treat it as unhandled and crash the process.
  try {
    ws.on('error', () => {});
  } catch {
    // ignore
  }

  try {
    // `terminate()` can throw if the socket was never established; `close()` is safer in CONNECTING.
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    } else {
      ws.terminate();
    }
  } catch {
    // ignore
  }
};

// Graceful close used by the connection pool. A pooled socket is healthy when it
// is retired (session age, option change, or TTS close), so a clean close frame
// is preferable to an abrupt terminate; terminate remains the fallback for a
// socket caught mid-handshake.
const safeCloseWebSocket = (ws: WebSocket) => {
  try {
    // `ws` can emit 'error' during teardown; without a listener Node treats it as
    // unhandled and crashes the process.
    ws.on('error', () => {});
  } catch {
    // ignore
  }

  try {
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      ws.close();
    } else if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      ws.terminate();
    }
  } catch {
    // ignore
  }
};

const connectCartesiaWebSocket = async ({
  url,
  headers,
  timeoutMs,
  abortSignal,
}: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<WebSocket> => {
  const connectOnce = async (family?: number): Promise<WebSocket> => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs, family, headers });
    try {
      await waitForWsOpen({ ws, timeoutMs, abortSignal });
      return ws;
    } catch (e) {
      safeTerminateWebSocket(ws);
      throw e;
    }
  };

  try {
    return await connectOnce();
  } catch (e) {
    // Mitigation for Node.js dual-stack (IPv6/IPv4) connect flakiness ("happy eyeballs"):
    // some environments surface `AggregateError` with nested `ETIMEDOUT` during the initial
    // WebSocket open. In that case we do a one-off retry forcing IPv4 (`family: 4`) before
    // letting the outer framework retry loop handle further attempts.
    //
    // If you still see `AggregateError`/`ETIMEDOUT`:
    // - Increase the session TTS connect timeout (`connOptions.ttsConnOptions.timeoutMs`)
    // - Or adjust Node's family autoselection behavior via `NODE_OPTIONS`, e.g.
    //   `--network-family-autoselection-attempt-timeout=5000` (or disable it entirely).
    if (hasAnyTransientCode(e) || isAggregateErrorLike(e)) {
      return await connectOnce(4);
    }
    throw e;
  }
};

const toCartesiaOptions = (
  opts: TTSOptions,
  streaming: boolean = false,
): { [id: string]: unknown } => {
  const voice: { [id: string]: unknown } = {};
  if (typeof opts.voice === 'string') {
    voice.mode = 'id';
    voice.id = opts.voice;
  } else {
    voice.mode = 'embedding';
    voice.embedding = opts.voice;
  }

  if (opts.apiVersion === API_VERSION_WITH_EXPERIMENTAL_CONTROLS) {
    const voiceControls: { [id: string]: unknown } = {};
    if (opts.speed) {
      voiceControls.speed = opts.speed;
    }
    if (opts.emotion) {
      voiceControls.emotion = opts.emotion;
    }
    if (Object.keys(voiceControls).length) {
      voice.__experimental_controls = voiceControls;
    }
  }

  const result: { [id: string]: unknown } = {
    model_id: opts.model,
    voice,
    output_format: {
      container: 'raw',
      encoding: opts.encoding,
      sample_rate: opts.sampleRate,
    },
    language: getBaseLanguage(opts.language),
    max_buffer_delay_ms: 0,
  };

  if (opts.pronunciationDictId) {
    result.pronunciation_dict_id = opts.pronunciationDictId;
  }

  if (opts.apiVersion > API_VERSION_WITH_EXPERIMENTAL_CONTROLS && isSonic3(opts.model)) {
    const generationConfig: { [id: string]: unknown } = {};
    if (opts.speed) {
      generationConfig.speed = opts.speed;
    }
    if (opts.emotion) {
      generationConfig.emotion = opts.emotion[0];
    }
    if (opts.volume) {
      generationConfig.volume = opts.volume;
    }
    if (Object.keys(generationConfig).length) {
      result.generation_config = generationConfig;
    }
  }

  if (streaming && opts.wordTimestamps !== false) {
    result.add_timestamps = true;
  }

  return result;
};
