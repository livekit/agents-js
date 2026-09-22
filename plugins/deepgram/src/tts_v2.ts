// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
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
  asError,
  log,
  shortuuid,
  stream,
  tokenize,
  tts,
  waitForWebSocketOpen,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { request } from 'node:https';
import * as queryString from 'node:querystring';
import { type RawData, WebSocket } from 'ws';
import type { FluxTTSModels } from './models.js';

const AUTHORIZATION_HEADER = 'Authorization';
const NUM_CHANNELS = 1;

// Flux TTS is served on the /v2/speak endpoint over both WebSocket (streaming) and
// REST (batch). A single https base URL works for both; the streaming path flips the
// scheme to wss.
// https://developers.deepgram.com/docs/flux-tts/overview
const BASE_URL_V2 = 'https://api.deepgram.com/v2/speak';

const FLUSH_MSG = JSON.stringify({ type: 'Flush' });
const CLOSE_MSG = JSON.stringify({ type: 'Close' });

// Deepgram recycles a pooled socket after this long so a very long call cannot keep
// one connection open indefinitely. Matches the Python plugin's 3600s.
const MAX_SESSION_DURATION_MS = 3_600_000;

// Inactivity budget for a batch synthesize() request, matching the Python plugin's
// ClientTimeout(total=30). Note this is a socket-idle timeout, not a total one: it covers
// a stalled connect and a stalled response body, but a slow-yet-steady response can still
// run past it. Without it a server that accepts the request and goes quiet would hang the
// call forever, since Node imposes no default timeout and the base retry loop only runs
// once run() settles.
const BATCH_REQUEST_TIMEOUT_MS = 30_000;

// Lets each SynthesizeStreamv2 reach the pool owned by the TTS that created it, without
// widening the public constructor signature with an internal type.
const connectionPools = new WeakMap<TTSv2, ConnectionPool<WebSocket>>();

/**
 * Audio encodings this plugin supports.
 *
 * Deepgram Flux also offers mp3/opus/flac/aac/mulaw/alaw, but AudioByteStream expects raw
 * PCM samples and the agents framework has no decode path, so this port only exposes linear16
 * (same restriction as the minimax plugin). The Python plugin accepts the compressed
 * encodings on its batch path because its AudioEmitter decodes by mime type.
 */
export type FluxTTSEncoding = 'linear16';

const SUPPORTED_ENCODINGS: readonly FluxTTSEncoding[] = ['linear16'];

const validateEncoding = (encoding: string): void => {
  if (!(SUPPORTED_ENCODINGS as readonly string[]).includes(encoding)) {
    throw new Error(
      `unsupported Deepgram Flux TTS encoding '${encoding}'; ` +
        `supported encodings are: ${SUPPORTED_ENCODINGS.join(', ')}`,
    );
  }
};

/**
 * Configuration options for {@link TTSv2} (Deepgram Flux TTS, the `/v2/speak` endpoint).
 */
export interface TTSv2Options {
  /**
   * Flux TTS model to use. Model names follow the `flux-{voice}-{language}` format.
   * @see https://developers.deepgram.com/docs/flux-tts/overview for available voices.
   */
  model: FluxTTSModels | string;
  /**
   * Audio encoding to use. Only `linear16` is supported: the LiveKit pipeline plays raw
   * PCM and this plugin does not decode compressed audio.
   */
  encoding: FluxTTSEncoding;
  /** Sample rate of audio in Hz. */
  sampleRate: number;
  /** Deepgram API key. Falls back to `$DEEPGRAM_API_KEY`. */
  apiKey?: string;
  /** Base URL for the Deepgram Flux TTS API. */
  baseUrl: string;
  /**
   * Opt out of the Deepgram Model Improvement Program. Defaults to false (requests may
   * be used to improve models).
   * @see https://dpgr.am/deepgram-mip
   */
  mipOptOut: boolean;
  /** Tokenizer used to split incoming text into the words sent to Flux. */
  wordTokenizer: tokenize.WordTokenizer;
}

const defaultTTSv2Options: TTSv2Options = {
  model: 'flux-alexis-en',
  encoding: 'linear16',
  sampleRate: 24000,
  apiKey: process.env.DEEPGRAM_API_KEY,
  baseUrl: BASE_URL_V2,
  mipOptOut: false,
  wordTokenizer: new tokenize.basic.WordTokenizer(false),
};

/**
 * Deepgram Flux TTS (the `/v2/speak` endpoint).
 *
 * Sits alongside {@link TTS}, the Aura client for `/v1/speak`; this class does not replace
 * it. Both the streaming ({@link TTSv2.stream}) and batch ({@link TTSv2.synthesize}) paths
 * emit `linear16` only — Deepgram also offers mp3/opus/flac/aac, but the LiveKit pipeline
 * plays raw PCM and this plugin ships no decoder, so any other encoding is rejected.
 *
 * @example
 * ```typescript
 * import { TTSv2 } from '@livekit/agents-plugin-deepgram';
 *
 * const tts = new TTSv2({ model: 'flux-alexis-en' });
 * ```
 */
export class TTSv2 extends tts.TTS {
  label = 'deepgram.TTSv2';
  #opts: TTSv2Options;
  #pool: ConnectionPool<WebSocket>;
  #closed = false;
  #logger = log();

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Deepgram';
  }

  override get sampleRate(): number {
    return this.#opts.sampleRate;
  }

  constructor(opts: Partial<TTSv2Options> = {}) {
    const resolvedOpts = { ...defaultTTSv2Options, ...opts };

    super(resolvedOpts.sampleRate, NUM_CHANNELS, { streaming: true });

    this.#opts = resolvedOpts;

    if (this.#opts.apiKey === undefined) {
      throw new Error(
        'Deepgram API key is required, whether as an argument or as $DEEPGRAM_API_KEY',
      );
    }

    validateEncoding(this.#opts.encoding);

    this.#pool = new ConnectionPool<WebSocket>({
      connectCb: (timeoutMs) => this.#connectWebSocket(timeoutMs),
      closeCb: (ws) => closeWebSocket(ws),
      maxSessionDuration: MAX_SESSION_DURATION_MS,
    });
    connectionPools.set(this, this.#pool);
  }

  updateOptions(opts: Partial<Pick<TTSv2Options, 'model' | 'encoding' | 'sampleRate'>>) {
    if (opts.encoding !== undefined) {
      validateEncoding(opts.encoding);
    }

    this.#opts = { ...this.#opts, ...opts };

    // These params are baked into the WebSocket URL at connection time, so any existing
    // pooled connection must be invalidated to avoid serving audio at the wrong
    // rate/encoding.
    if (opts.model !== undefined || opts.encoding !== undefined || opts.sampleRate !== undefined) {
      this.#pool.invalidate();
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStreamv2(this, text, { ...this.#opts }, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SynthesizeStreamv2(this, { ...this.#opts }, options?.connOptions);
  }

  /**
   * Open the pooled WebSocket ahead of the first generation so the first turn does not
   * pay the connect. Safe to call more than once.
   */
  prewarm(): void {
    this.#pool.prewarm();
  }

  /** Drop every pooled connection; the pool reconnects on the next synthesis. */
  override async releaseConnections(): Promise<void> {
    await this.#pool.close();
  }

  override async close(): Promise<void> {
    this.#closed = true;
    await this.#pool.close();
    await super.close();
  }

  async #connectWebSocket(timeoutMs: number): Promise<WebSocket> {
    const config = {
      encoding: this.#opts.encoding,
      model: this.#opts.model,
      sample_rate: this.#opts.sampleRate,
      mip_opt_out: String(this.#opts.mipOptOut),
    };
    const baseUrl = this.#opts.baseUrl.replace(/^http/, 'ws');
    const url = `${baseUrl}?${queryString.stringify(config)}`;

    const ws = new WebSocket(url, {
      handshakeTimeout: timeoutMs,
      headers: { [AUTHORIZATION_HEADER]: `Token ${this.#opts.apiKey!}` },
    });

    try {
      await waitForWebSocketOpen(ws, 'Deepgram');
    } catch (error) {
      await closeWebSocket(ws);
      if (error instanceof APIError) throw error;
      throw new APIConnectionError({
        message: `failed to connect to Deepgram Flux TTS (${asError(error).name})`,
      });
    }

    if (this.#closed) {
      await closeWebSocket(ws);
      throw new APIConnectionError({ message: 'Deepgram Flux TTS is closed' });
    }

    this.#logger.debug('Established new Deepgram Flux TTS WebSocket connection');

    // Drop a socket that closes (or errors) while idle in the pool. Between turns no
    // generation listeners are attached, so without this the pool keeps a dead socket in
    // `available` and the next turn spends a retry to discard it. The no-op error
    // listener also stops an idle 'error' from crashing the process.
    ws.on('error', () => {});
    ws.on('close', () => this.#pool.remove(ws));

    return ws;
  }
}

/** Batch synthesis against `POST /v2/speak`. */
export class ChunkedStreamv2 extends tts.ChunkedStream {
  label = 'deepgram.ChunkedStreamv2';
  #logger = log();
  #opts: TTSv2Options;
  #text: string;

  constructor(
    tts: TTSv2,
    text: string,
    opts: TTSv2Options,
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

    const params: Record<string, string | number> = {
      encoding: this.#opts.encoding,
      container: 'none',
      model: this.#opts.model,
      sample_rate: this.#opts.sampleRate,
      mip_opt_out: String(this.#opts.mipOptOut),
    };

    const url = new URL(this.#opts.baseUrl);
    url.search = queryString.stringify(params);

    const doneFut = new Future<void>();

    const req = request(
      {
        hostname: url.hostname,
        port: parseInt(url.port) || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          [AUTHORIZATION_HEADER]: `Token ${this.#opts.apiKey!}`,
          'Content-Type': 'application/json',
        },
        signal: this.abortSignal,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          if (!doneFut.done) {
            doneFut.reject(
              new APIStatusError({
                message: `Deepgram Flux TTS HTTP request failed: ${res.statusCode} ${res.statusMessage}`,
                options: { statusCode: res.statusCode ?? -1 },
              }),
            );
          }
          return;
        }

        res.on('data', (chunk: Buffer) => {
          for (const frame of bstream.write(chunk)) {
            if (!this.queue.closed) {
              this.queue.put({ requestId, frame, final: false, segmentId: requestId });
            }
          }
        });

        res.on('error', (err) => {
          if (err.message === 'aborted') return;
          this.#logger.error({ err }, 'Deepgram Flux TTS response error');
          if (!doneFut.done) doneFut.reject(err);
        });

        res.on('close', () => {
          for (const frame of bstream.flush()) {
            if (!this.queue.closed) {
              this.queue.put({ requestId, frame, final: false, segmentId: requestId });
            }
          }
          if (!this.queue.closed) this.queue.close();
          if (!doneFut.done) doneFut.resolve();
        });
      },
    );

    req.on('error', (err) => {
      if (err.name === 'AbortError') return;
      // The timeout below destroys the request with its own error, which then arrives
      // here; it is already an explanatory APITimeoutError, so don't log it as unexpected.
      if (!(err instanceof APITimeoutError)) {
        this.#logger.error({ err }, 'Deepgram Flux TTS request error');
      }
      if (!doneFut.done) doneFut.reject(err);
    });
    req.on('close', () => {
      if (!doneFut.done) doneFut.resolve();
    });

    // 'error' fires before 'close', so the reject below wins over the close handler's
    // resolve. APITimeoutError is retryable, so the base ChunkedStream retry loop picks
    // this up rather than the turn dying outright.
    req.setTimeout(BATCH_REQUEST_TIMEOUT_MS, () => {
      req.destroy(
        new APITimeoutError({
          message: `Deepgram Flux TTS request timed out after ${BATCH_REQUEST_TIMEOUT_MS}ms`,
        }),
      );
    });

    req.write(JSON.stringify({ text: this.#text }));
    req.end();

    try {
      await doneFut.await;
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (!this.queue.closed) this.queue.close();
      if (e instanceof APIError) throw e;
      throw new APIConnectionError({
        message: `Deepgram Flux TTS request failed: ${asError(e).message || 'unknown error'}`,
      });
    }
  }
}

/** Streaming synthesis against the `/v2/speak` WebSocket. */
export class SynthesizeStreamv2 extends tts.SynthesizeStream {
  label = 'deepgram.SynthesizeStreamv2';
  #opts: TTSv2Options;
  #pool: ConnectionPool<WebSocket>;
  #logger = log();

  constructor(tts: TTSv2, opts: TTSv2Options, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    const pool = connectionPools.get(tts);
    if (!pool) throw new Error('Deepgram Flux TTS connection pool is not initialized');
    this.#pool = pool;
    this.#opts = opts;
  }

  protected async run() {
    // Only linear16 is playable end-to-end through the LiveKit pipeline. Fail fast with a
    // clear message instead of at connect time.
    validateEncoding(this.#opts.encoding);

    const requestId = shortuuid();
    const segments = stream.createStreamChannel<tokenize.WordStream>();

    // Converts incoming text into WordStreams, one per flushed segment.
    const tokenizeInput = async () => {
      let wordStream: tokenize.WordStream | undefined;
      try {
        for await (const data of this.input) {
          if (data === SynthesizeStreamv2.FLUSH_SENTINEL) {
            if (wordStream) wordStream.endInput();
            wordStream = undefined;
            continue;
          }
          if (!wordStream) {
            wordStream = this.#opts.wordTokenizer.stream();
            await segments.write(wordStream);
          }
          wordStream.pushText(data);
        }
        if (wordStream) wordStream.endInput();
      } finally {
        await segments.close();
      }
    };

    const runSegments = async () => {
      const reader = segments.stream().getReader();
      try {
        while (!this.closed && !this.abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          await this.#runWs(value, requestId);
        }
      } finally {
        reader.releaseLock();
      }
    };

    try {
      await Promise.all([tokenizeInput(), runSegments()]);
    } catch (e) {
      if (this.abortController.signal.aborted) return;
      if (e instanceof APIError) throw e;
      throw new APIConnectionError({
        message: `Deepgram Flux TTS WebSocket failed: ${asError(e).message || 'unknown error'}`,
      });
    }
  }

  async #runWs(wordStream: tokenize.WordStream, requestId: string): Promise<void> {
    const segmentId = shortuuid();

    // The receive side must not start its idle timer before any text has been sent: the
    // server says nothing until it has something to synthesize.
    let markInputSent: () => void = () => {};
    const inputSent = new Promise<void>((resolve) => {
      markInputSent = resolve;
    });

    const sendTask = async (ws: WebSocket) => {
      try {
        for await (const word of wordStream) {
          if (this.abortController.signal.aborted) break;
          this.markStarted();
          ws.send(JSON.stringify({ type: 'Speak', text: `${word.token} ` }));
          markInputSent();
        }

        // always flush after a segment to end the active turn
        if (!this.abortController.signal.aborted) {
          ws.send(FLUSH_MSG);
        }
      } finally {
        markInputSent();
      }
    };

    const recvTask = async (ws: WebSocket) => {
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
      let lastFrame: AudioFrame | undefined;
      let timeout: NodeJS.Timeout | null = null;
      // Set once SpeechMetadata has been handled. Until then, a socket close is a
      // mid-generation drop, not a normal end.
      let completed = false;

      const sendLastFrame = (final: boolean) => {
        if (lastFrame && !this.queue.closed) {
          this.queue.put({ requestId, segmentId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };

      const clearMessageTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      await inputSent;
      if (this.abortController.signal.aborted) return;

      const fut = new Future<void>();

      const onMessage = (data: RawData, isBinary: boolean) => {
        clearMessageTimeout();

        if (isBinary) {
          const buffer =
            data instanceof Buffer
              ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
              : (data as ArrayBuffer);
          for (const frame of bstream.write(buffer as ArrayBuffer)) {
            sendLastFrame(false);
            lastFrame = frame;
          }
          resetMessageTimeout();
          return;
        }

        let message: { type?: string; [key: string]: unknown };
        try {
          message = JSON.parse(data.toString());
        } catch (err) {
          this.#logger.warn({ err }, 'Failed to parse Deepgram Flux TTS message');
          resetMessageTimeout();
          return;
        }

        // Flux server messages:
        // https://developers.deepgram.com/docs/flux-tts/overview
        switch (message.type) {
          case 'SpeechMetadata':
            // Authoritative end-of-turn marker: all audio for the turn has been sent
            // between SpeechStarted and this message. The server emits a trailing Flushed
            // frame after this; on a pooled reuse it is harmlessly absorbed as a no-op at
            // the top of the next turn.
            for (const frame of bstream.flush()) {
              sendLastFrame(false);
              lastFrame = frame;
            }
            sendLastFrame(true);
            if (!this.queue.closed) {
              this.queue.put(SynthesizeStreamv2.END_OF_STREAM);
            }
            completed = true;
            if (!fut.done) fut.resolve();
            return;
          case 'Connected':
          case 'SpeechStarted':
          case 'Flushed':
          case 'SessionMetadata':
            // lifecycle / telemetry messages, no audio action needed
            break;
          case 'Warning':
            this.#logger.warn(
              { code: message.code },
              `Deepgram warning: ${message.description ?? message.warn_msg}`,
            );
            break;
          case 'Error':
          case 'error':
            if (!fut.done) {
              fut.reject(new APIError('Deepgram Flux TTS returned error', { body: message }));
            }
            return;
          default:
            this.#logger.warn({ 'lk.pii.message': message }, 'Unknown Deepgram message type');
        }

        resetMessageTimeout();
      };

      const resetMessageTimeout = () => {
        clearMessageTimeout();
        timeout = setTimeout(() => {
          if (!fut.done) {
            fut.reject(new APITimeoutError({ message: 'Deepgram Flux TTS recv idle timeout' }));
          }
        }, this.connOptions.timeoutMs);
      };

      const onClose = (code: number, reason: Buffer) => {
        clearMessageTimeout();
        if (completed) {
          if (!fut.done) fut.resolve();
          return;
        }
        if (!fut.done) {
          fut.reject(
            new APIStatusError({
              message: 'Deepgram websocket connection closed unexpectedly',
              options: { statusCode: code || -1, body: { reason: reason.toString() } },
            }),
          );
        }
      };

      const onError = (err: Error) => {
        clearMessageTimeout();
        if (!fut.done) fut.reject(err);
      };

      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
      resetMessageTimeout();

      try {
        await fut.await;
      } finally {
        clearMessageTimeout();
        // Remove listeners so the socket can be reused by the next segment.
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
      }
    };

    // The pool hands back one live socket per call and reclaims it on success (put) or
    // discards it on any thrown error (remove). A segment never closes the socket itself,
    // so the next segment skips the handshake.
    await this.#pool.withConnection(
      async (ws) => {
        if (ws.readyState !== WebSocket.OPEN) {
          throw new APIConnectionError({
            message: 'Deepgram Flux TTS pooled websocket is not open',
          });
        }
        try {
          await Promise.all([sendTask(ws), recvTask(ws)]);
        } finally {
          markInputSent();
        }
      },
      { timeout: this.connOptions.timeoutMs, signal: this.abortController.signal },
    );
  }
}

/**
 * Graceful close used by the connection pool.
 *
 * Sends Flush and Close so Deepgram processes all remaining audio and terminates the
 * session, then waits briefly for an acknowledgment. Without this, lingering TTS sessions
 * accumulate and eventually produce 429s.
 */
const closeWebSocket = async (ws: WebSocket): Promise<void> => {
  // `ws` can emit 'error' during teardown; without a listener Node treats it as unhandled
  // and crashes the process.
  ws.on('error', () => {});

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(FLUSH_MSG);
      ws.send(CLOSE_MSG);

      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        ws.once('message', done);
        ws.once('close', done);
        ws.once('error', done);
      });
    }
  } catch (e) {
    log().warn({ err: asError(e) }, 'Error during WebSocket close sequence');
  } finally {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {
      // ignore
    }
  }
};
