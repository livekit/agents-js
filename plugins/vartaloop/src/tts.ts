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
  DEFAULT_API_CONNECT_OPTIONS,
  Future,
  asError,
  log,
  shortuuid,
  stream,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { type RawData, WebSocket } from 'ws';
import type { TTSDigits, TTSExpressions, TTSModels, TTSProfiles, TTSVoices } from './models.js';

const DEFAULT_BASE_URL = 'https://api.vartaloop.ai';
const DEFAULT_MODEL: TTSModels = 'narad';
const DEFAULT_VOICE: TTSVoices = 'saanvi';
const API_KEY_ENV = 'VARTALOOP_API_KEY';
const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const USER_AGENT = `agents-plugin-vartaloop/${__PACKAGE_VERSION__}`;
// A pooled socket is reopened after this long so one call cannot pin a connection forever.
const MAX_SESSION_DURATION_MS = 300_000;
// Wall-time ceiling for one REST request (the server's own per-request limit is 120 s).
const HTTP_TOTAL_TIMEOUT_MS = 120_000;

// Lets each SynthesizeStream reach the pool owned by the TTS that created it,
// without widening the constructor signature the base class fixes.
const connectionPools = new WeakMap<TTS, ConnectionPool<WebSocket>>();
// The TTS's current options, read by its streams when each utterance is sent so that
// `updateOptions()` applies from the next sentence on, even mid-stream.
const currentOptions = new WeakMap<TTS, TTSOptions>();

/**
 * Options of the Vartaloop TTS. Every option but `apiKey`, `baseUrl`, `sampleRate` and
 * `chunkTimeout` travels in the body of each utterance, so {@link TTS.updateOptions} applies it
 * from the next sentence on without reconnecting.
 */
export interface TTSOptions {
  /**
   * The model family. The API has no model field: the value names the model in metrics and logs.
   * @defaultValue 'narad'
   */
  model: TTSModels | string;
  /**
   * The voice id. The voice decides the language and so the text normaliser: Hinglish text to a
   * Hinglish voice, English text to an English one. `GET /v1/voices` lists the ids.
   * @defaultValue 'saanvi'
   */
  voice: TTSVoices | string;
  /**
   * Delivery of the voice: `neutral`, `excited`, `sad` or `whisper`. A voice without that
   * expression plays neutral.
   * @defaultValue 'neutral'
   */
  expression: TTSExpressions | string;
  /**
   * The language digits are read in for Hinglish voices: `auto`, `hi`, `mixed` or `en`.
   * @defaultValue 'auto'
   */
  digits: TTSDigits | string;
  /** Speaking pace, 0.5 to 2.0; the pitch stays the same. Unset plays the voice's natural pace. */
  speed?: number;
  /** Sampling noise, 0 to 2 (server default 0.3). */
  temperature?: number;
  /** Fixes the sampling noise for reproducible output. */
  seed?: number;
  /**
   * The server's output chain (loudness to -16 LUFS, high-pass, true-peak limiter). Unset keeps
   * the server default (on).
   */
  postfx?: boolean;
  /** `default` or `telephony`; the latter shapes the audio for 8 kHz mu-law delivery. */
  profile?: TTSProfiles | string;
  /**
   * Skip the server's text normaliser (the text is already normalised).
   * @defaultValue false
   */
  raw: boolean;
  /**
   * Output sample rate. The API produces 24 kHz audio; this must be 24000.
   * @defaultValue 24000
   */
  sampleRate: number;
  /** The Vartaloop API key. Read from the `VARTALOOP_API_KEY` environment variable when not given. */
  apiKey?: string;
  /**
   * The API base URL.
   * @defaultValue 'https://api.vartaloop.ai'
   */
  baseUrl: string;
  /**
   * How long, in milliseconds, to wait for the next WebSocket message while an utterance is in
   * flight before the socket is considered stuck and the turn retried on a fresh one.
   * @defaultValue 10000
   */
  chunkTimeout: number;
}

const defaultTTSOptions: TTSOptions = {
  model: DEFAULT_MODEL,
  voice: DEFAULT_VOICE,
  expression: 'neutral',
  digits: 'auto',
  raw: false,
  sampleRate: SAMPLE_RATE,
  apiKey: process.env[API_KEY_ENV],
  baseUrl: DEFAULT_BASE_URL,
  chunkTimeout: 10_000,
};

const DIGITS: readonly string[] = ['auto', 'hi', 'mixed', 'en'];
const PROFILES: readonly string[] = ['default', 'telephony'];

const checkOptions = (opts: TTSOptions) => {
  if (opts.speed !== undefined && !(opts.speed >= 0.5 && opts.speed <= 2.0)) {
    throw new Error('speed must be between 0.5 and 2.0');
  }
  if (opts.temperature !== undefined && !(opts.temperature >= 0 && opts.temperature <= 2)) {
    throw new Error('temperature must be between 0 and 2');
  }
  if (!DIGITS.includes(opts.digits)) {
    throw new Error('digits must be auto, hi, mixed or en');
  }
  if (opts.profile !== undefined && !PROFILES.includes(opts.profile)) {
    throw new Error('profile must be default or telephony');
  }
};

/** A server event on the WebSocket; binary frames carry the audio itself. */
interface ServerEvent {
  type: 'start' | 'chunk' | 'first_audio_ms' | 'chunk_end' | 'end' | 'error' | string;
  request_id?: string;
  error?: string;
  status?: number;
  retry_after?: number;
}

/**
 * Text-to-speech over the Vartaloop API: Hinglish and Indian-language voices as 16-bit PCM mono
 * at 24 kHz.
 *
 * @remarks
 * `stream()` sends every sentence as its own utterance over a pooled `WS /v1/tts/stream`
 * connection; the server queues them in order and streams the audio of each one back, so
 * sentence N+1 is synthesised while N is still playing. `synthesize()` is one `POST /v1/tts` per
 * text whose chunked body is forwarded as it arrives.
 */
export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #pool: ConnectionPool<WebSocket>;
  #closed = false;
  label = 'vartaloop.TTS';

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Vartaloop';
  }

  /**
   * Create a new instance of Vartaloop TTS.
   *
   * @remarks
   * `apiKey` must be set to your Vartaloop API key, either using the argument or by setting the
   * `VARTALOOP_API_KEY` environment variable.
   */
  constructor(opts: Partial<TTSOptions> = {}) {
    const resolvedOpts: TTSOptions = { ...defaultTTSOptions, ...opts };
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true, alignedTranscript: false });

    if (!resolvedOpts.apiKey) {
      throw new Error(
        `Vartaloop API key is required, whether as an argument or as $${API_KEY_ENV}`,
      );
    }
    if (resolvedOpts.sampleRate !== SAMPLE_RATE) {
      throw new Error(`Vartaloop TTS produces ${SAMPLE_RATE} Hz audio; sampleRate must be it`);
    }
    resolvedOpts.baseUrl = resolvedOpts.baseUrl.replace(/\/+$/, '');
    checkOptions(resolvedOpts);
    this.#opts = resolvedOpts;
    currentOptions.set(this, this.#opts);

    this.#pool = new ConnectionPool<WebSocket>({
      connectCb: (timeoutMs) => this.#connectWebSocket(timeoutMs),
      closeCb: async (ws) => safeCloseWebSocket(ws),
      maxSessionDuration: MAX_SESSION_DURATION_MS,
      markRefreshedOnGet: true,
    });
    connectionPools.set(this, this.#pool);
  }

  /**
   * Update the TTS options.
   *
   * @remarks
   * Every option travels in the body of each utterance, so a change applies from the next
   * sentence on and the pooled WebSocket is kept. Only a new `apiKey` or `baseUrl` reconnects,
   * because those reach the server at handshake time.
   */
  updateOptions(opts: Partial<TTSOptions>) {
    const handshakeChanged =
      (opts.apiKey !== undefined && opts.apiKey !== this.#opts.apiKey) ||
      (opts.baseUrl !== undefined && opts.baseUrl.replace(/\/+$/, '') !== this.#opts.baseUrl);

    const next: TTSOptions = { ...this.#opts, ...opts };
    if (!next.apiKey) {
      throw new Error(
        `Vartaloop API key is required, whether as an argument or as $${API_KEY_ENV}`,
      );
    }
    if (next.sampleRate !== SAMPLE_RATE) {
      throw new Error(`Vartaloop TTS produces ${SAMPLE_RATE} Hz audio; sampleRate must be it`);
    }
    next.baseUrl = next.baseUrl.replace(/\/+$/, '');
    checkOptions(next);
    this.#opts = next;
    currentOptions.set(this, this.#opts);

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
   * Open the pooled WebSocket ahead of the first turn so the greeting does not pay the TCP + TLS
   * handshake. Safe to call more than once; it is a no-op when a connection already exists.
   */
  prewarm(): void {
    this.#pool.prewarm();
  }

  /** Release pooled connections; an in-flight synthesis keeps its until it finishes. */
  override async releaseIdleConnections(): Promise<void> {
    await this.#pool.releaseIdle();
  }

  override async close(): Promise<void> {
    this.#closed = true;
    await this.#pool.close();
    await super.close();
  }

  async #connectWebSocket(timeoutMs: number): Promise<WebSocket> {
    // Snapshot the handshake inputs. If a concurrent updateOptions() changes one
    // of them while this connect is in flight, reconnect on the new value rather
    // than pooling a socket built on stale credentials.
    const apiKey = this.#opts.apiKey!;
    const baseUrl = this.#opts.baseUrl;
    const ws = await connectWebSocket({
      url: `${baseUrl.replace(/^http/, 'ws')}/v1/tts/stream`,
      headers: authHeaders(apiKey),
      timeoutMs,
    });
    if (this.#closed) {
      safeCloseWebSocket(ws);
      throw new APIConnectionError({ message: 'Vartaloop TTS is closed' });
    }
    if (apiKey !== this.#opts.apiKey || baseUrl !== this.#opts.baseUrl) {
      safeCloseWebSocket(ws);
      return await this.#connectWebSocket(timeoutMs);
    }
    // Drop a socket that closes (or errors) while idle in the pool, so the next turn does not
    // spend a retry on a dead one. The no-op error listener also keeps an idle 'error' from
    // crashing the process. Remove is a no-op once the socket is no longer pooled.
    ws.on('error', () => {});
    ws.on('close', () => this.#pool.remove(ws));
    return ws;
  }
}

/** Synthesize one text over `POST /v1/tts`, forwarding the chunked PCM body as it arrives. */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'vartaloop.ChunkedStream';
  #logger = log();
  #opts: TTSOptions;
  #text: string;
  #connectTimeoutMs: number;

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
    this.#connectTimeoutMs = (connOptions ?? DEFAULT_API_CONNECT_OPTIONS).timeoutMs;
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const body = _toVartaloopBody(this.#opts, this.#text, requestId);
    body.stream = true;
    const payload = JSON.stringify(body);

    const baseUrl = new URL(this.#opts.baseUrl);
    const request = baseUrl.protocol === 'http:' ? httpRequest : httpsRequest;
    const doneFut = new Future<void>();

    const req = request(
      {
        hostname: baseUrl.hostname,
        port: parseInt(baseUrl.port) || (baseUrl.protocol === 'https:' ? 443 : 80),
        path: `${baseUrl.pathname.replace(/\/$/, '')}/v1/tts`,
        method: 'POST',
        headers: {
          ...authHeaders(this.#opts.apiKey!),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: this.#connectTimeoutMs,
        signal: this.abortSignal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const serverRequestId = headerValue(res.headers['x-request-id']) ?? requestId;
        if (status !== 200) {
          // The error is decided before any audio: the whole body is the message.
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            if (doneFut.done) return;
            doneFut.reject(
              statusError(status, Buffer.concat(chunks).toString('utf8'), {
                requestId: serverRequestId,
                retryAfter: headerValue(res.headers['retry-after']),
              }),
            );
          });
          res.on('error', (err) => {
            if (!doneFut.done) doneFut.reject(err);
          });
          return;
        }

        // Each transfer chunk is forwarded as it lands: the first one is the first 80 ms frame,
        // the rest follow ahead of real time.
        res.on('data', (chunk: Buffer) => {
          for (const frame of bstream.write(chunk)) {
            this.queue.put({
              requestId: serverRequestId,
              segmentId: requestId,
              frame,
              final: false,
            });
          }
        });
        res.on('end', () => {
          for (const frame of bstream.flush()) {
            this.queue.put({
              requestId: serverRequestId,
              segmentId: requestId,
              frame,
              final: false,
            });
          }
          this.queue.close();
          if (!doneFut.done) doneFut.resolve();
        });
        res.on('close', () => {
          // A connection that closes before the body is complete truncated the audio: fail the
          // request (retryable) instead of passing the cut-off speech as a success.
          if (!doneFut.done && !res.complete) {
            doneFut.reject(
              new APIConnectionError({ message: 'Vartaloop TTS response ended before the body' }),
            );
          }
        });
        res.on('error', (err) => {
          if (err.message === 'aborted') return;
          this.#logger.error({ err }, 'Vartaloop TTS response error');
          if (!doneFut.done) doneFut.reject(err);
        });
      },
    );

    req.on('timeout', () => {
      if (!doneFut.done) {
        doneFut.reject(new APITimeoutError({ message: 'Vartaloop TTS request timed out' }));
      }
      req.destroy();
    });
    req.on('error', (err) => {
      if (err.name === 'AbortError') return;
      this.#logger.error({ err }, 'Vartaloop TTS request error');
      if (!doneFut.done) doneFut.reject(err);
    });
    req.on('close', () => {
      // Closed before any response arrived (or before the response completed).
      if (!doneFut.done) {
        doneFut.reject(
          new APIConnectionError({ message: 'Vartaloop TTS connection closed before a response' }),
        );
      }
    });
    const totalTimer = setTimeout(() => {
      if (!doneFut.done) {
        doneFut.reject(new APITimeoutError({ message: 'Vartaloop TTS request timed out' }));
      }
      req.destroy();
    }, HTTP_TOTAL_TIMEOUT_MS);
    req.end(payload);

    try {
      await doneFut.await;
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (!this.queue.closed) this.queue.close();
      if (e instanceof APIError) throw e;
      throw toRetryableConnectionError(e);
    } finally {
      clearTimeout(totalTimer);
    }
  }
}

/**
 * Streamed synthesis over the pooled `WS /v1/tts/stream` connection.
 *
 * @remarks
 * Text pushed by the agent is cut into sentences; each sentence is one utterance message with its
 * own `request_id`. The server serves them in order on the connection, so the next sentence is
 * already being synthesised while the current one plays. Binary frames are the PCM of the
 * utterance in progress; `start` and `end` events delimit it.
 *
 * The text pushed in is kept for the life of the stream, so a retry after a retryable error
 * before any audio was heard (a 503 while every worker is busy, a dropped socket) re-sends the
 * same sentences instead of losing them. Once a frame has been emitted a failure is final: a
 * retry would speak the start of the interrupted sentence twice.
 */
export class SynthesizeStream extends tts.SynthesizeStream {
  #tts: TTS;
  #opts: TTSOptions;
  #overrides: Partial<TTSOptions> = {};
  #pool: ConnectionPool<WebSocket>;
  #logger = log();
  // Everything pushed into the stream, in order, for every attempt to tokenize from.
  #inputLog: (string | typeof SynthesizeStream.FLUSH_SENTINEL)[] = [];
  #inputEnded = false;
  #inputChanged = new Future<void>();
  #inputPumpStarted = false;
  // Set once a frame reached the queue. From then on a failure is final: a retry would speak
  // the start of the interrupted sentence twice.
  #audioEmitted = false;
  // Segment ids, one per segment the tokenizer produced, in order. The tokenizer is
  // deterministic over the input log, so its k-th segment on a retry is the same text as the
  // k-th segment of the first attempt, and both are reported under the same id.
  #segmentIds: string[] = [];
  label = 'vartaloop.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    const pool = connectionPools.get(tts);
    if (!pool) throw new Error('Vartaloop connection pool is not initialized');
    this.#tts = tts;
    this.#pool = pool;
    this.#opts = opts;
  }

  /**
   * Update the options of this stream only. The change applies to the sentences sent from now
   * on, on top of the owning TTS's options; the connection is kept.
   */
  updateOptions(opts: Partial<TTSOptions>) {
    const next = { ...this.#opts, ...this.#overrides, ...opts };
    checkOptions(next);
    this.#overrides = { ...this.#overrides, ...opts };
  }

  // The options of the next utterance: the TTS's current ones (so `tts.updateOptions()` applies
  // mid-stream) under this stream's own overrides. The handshake inputs (apiKey, baseUrl) stay
  // those of the checked-out socket.
  #utteranceOptions(): TTSOptions {
    return { ...(currentOptions.get(this.#tts) ?? this.#opts), ...this.#overrides };
  }

  #wakeInputReaders() {
    const changed = this.#inputChanged;
    this.#inputChanged = new Future<void>();
    changed.resolve();
  }

  // The single consumer of `this.input`: appends every item to the log that each attempt
  // replays. Started by the first attempt; later attempts find the log already filling.
  #startInputPump() {
    if (this.#inputPumpStarted) return;
    this.#inputPumpStarted = true;
    void (async () => {
      try {
        for await (const data of this.input) {
          this.#inputLog.push(data);
          this.#wakeInputReaders();
        }
      } catch (error) {
        this.#logger.debug({ error }, 'Vartaloop TTS input closed');
      } finally {
        this.#inputEnded = true;
        this.#wakeInputReaders();
      }
    })();
  }

  // Replays the log from the start, then follows it as new text arrives, until the input ends
  // or the attempt that reads it is over.
  async *#replayInput(stopped: () => boolean) {
    let index = 0;
    while (!stopped()) {
      if (index < this.#inputLog.length) {
        yield this.#inputLog[index++]!;
        continue;
      }
      if (this.#inputEnded) return;
      await this.#inputChanged.await;
    }
  }

  protected async run() {
    const requestId = shortuuid();
    this.#startInputPump();
    const tokenizer = new tokenize.basic.SentenceTokenizer().stream();
    // Utterances sent and not yet ended, in order.
    const pending: { utteranceId: string; segmentId: string }[] = [];
    // Set once the sender has nothing more to send (or the sender failed).
    let senderDone = false;
    let attemptOver = false;
    const SENDER_DONE = Symbol('SENDER_DONE');
    // Everything the receive loop reacts to: server messages, and the sender finishing.
    type Incoming = { data: RawData; isBinary: boolean } | typeof SENDER_DONE;
    const eventChannel = stream.createStreamChannel<Incoming>();
    const signal = (value: Incoming) => {
      void eventChannel.write(value).catch((error: unknown) => {
        this.#logger.debug({ error }, 'Failed writing Vartaloop event to channel (likely closed)');
      });
    };

    // The chunk watchdog: armed as soon as an utterance is pending (right after its send), reset
    // on every message the server sends, cleared when nothing is pending. While an utterance is
    // in flight the server speaks at least every few hundred milliseconds; silence longer than
    // `chunkTimeout` means the socket is stuck, and a stuck socket is discarded, not pooled.
    let watchdog: NodeJS.Timeout | undefined;
    let timedOut = false;
    let socket: WebSocket | undefined;
    const clearWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
    };
    const armWatchdog = () => {
      clearWatchdog();
      if (pending.length === 0 || timedOut) return;
      watchdog = setTimeout(() => {
        this.#logger.debug(
          `Vartaloop WebSocket TTS chunk stream timeout after ${this.#opts.chunkTimeout}ms`,
        );
        timedOut = true;
        if (socket) safeCloseWebSocket(socket);
        void eventChannel.close();
      }, this.#opts.chunkTimeout);
    };

    const inputTask = async () => {
      try {
        for await (const data of this.#replayInput(() => attemptOver)) {
          if (data === SynthesizeStream.FLUSH_SENTINEL) {
            tokenizer.flush();
            continue;
          }
          tokenizer.pushText(data);
        }
      } finally {
        tokenizer.endInput();
        tokenizer.close();
      }
    };

    const sendTask = async (ws: WebSocket) => {
      // This attempt's tokenizer segment ids, in order of appearance, mapped onto the stream's
      // stable ones so a retry keeps the segment ids of the first attempt.
      const tokenizerSegments: string[] = [];
      const stableSegmentId = (tokenizerSegment: string): string => {
        let index = tokenizerSegments.indexOf(tokenizerSegment);
        if (index === -1) {
          index = tokenizerSegments.push(tokenizerSegment) - 1;
        }
        return (this.#segmentIds[index] ??= shortuuid());
      };
      try {
        for await (const event of tokenizer) {
          if (this.abortController.signal.aborted || attemptOver) break;
          const text = event.token.trim();
          if (!text) continue;
          const utteranceId = shortuuid();
          const body = _toVartaloopBody(this.#utteranceOptions(), text, utteranceId);
          if (ws.readyState !== WebSocket.OPEN) {
            throw new APIConnectionError({ message: 'Vartaloop WebSocket closed mid-generation' });
          }
          pending.push({ utteranceId, segmentId: stableSegmentId(event.segmentId || requestId) });
          this.markStarted();
          ws.send(JSON.stringify(body));
          if (pending.length === 1) armWatchdog();
        }
      } finally {
        senderDone = true;
        signal(SENDER_DONE);
      }
    };

    const recvTask = async (ws: WebSocket) => {
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
      let lastFrame: AudioFrame | undefined;
      let lastSegmentId: string | undefined;
      // The utterance whose audio is arriving (the head of `pending` once its `start` came).
      let currentUtterance: string | undefined;
      let currentSegment: string | undefined;
      // Set once every utterance ended. Until then, a socket close or error is a
      // mid-generation drop, not a normal end.
      let completed = false;
      let streamError: Error | undefined;

      const sendLastFrame = (final: boolean) => {
        if (lastFrame && lastSegmentId !== undefined && !this.queue.closed) {
          this.queue.put({ requestId, segmentId: lastSegmentId, frame: lastFrame, final });
          this.#audioEmitted = true;
          lastFrame = undefined;
        }
      };
      const pushFrames = (frames: AudioFrame[], segmentId: string) => {
        for (const frame of frames) {
          sendLastFrame(false);
          lastFrame = frame;
          lastSegmentId = segmentId;
        }
      };

      const onMessage = (data: RawData, isBinary: boolean) => signal({ data, isBinary });
      const onClose = (code: number, reason: Buffer) => {
        this.#logger.debug(`WebSocket closed with code ${code}: ${reason.toString()}`);
        clearWatchdog();
        if (!completed && !timedOut && !streamError) {
          streamError = new APIConnectionError({
            message: `Vartaloop WebSocket closed mid-generation (code=${code})`,
          });
        }
        void eventChannel.close();
      };
      const onError = (err: Error) => {
        this.#logger.error({ err }, 'Vartaloop WebSocket error');
        if (!completed && !timedOut && !streamError) {
          streamError = err instanceof APIError ? err : toRetryableConnectionError(err);
        }
        void eventChannel.close();
      };

      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);

      const finish = () => {
        pushFrames(bstream.flush(), currentSegment ?? lastSegmentId ?? requestId);
        sendLastFrame(true);
        if (!this.queue.closed) {
          this.queue.put(SynthesizeStream.END_OF_STREAM);
        }
        clearWatchdog();
        completed = true;
      };

      try {
        const reader = eventChannel.stream().getReader();
        while (!this.closed && !this.abortController.signal.aborted) {
          const result = await reader.read();
          if (result.done) break;
          const raw = result.value;

          if (raw === SENDER_DONE) {
            if (pending.length === 0) {
              // Nothing sent, or every utterance already ended.
              finish();
              break;
            }
            continue;
          }

          armWatchdog();

          if (raw.isBinary) {
            // Audio of an utterance we did not start (a stale pooled socket) is dropped.
            if (currentUtterance === undefined || currentSegment === undefined) continue;
            pushFrames(bstream.write(toBuffer(raw.data)), currentSegment);
            continue;
          }

          let event: ServerEvent;
          try {
            event = JSON.parse(toBuffer(raw.data).toString('utf8')) as ServerEvent;
          } catch (parseErr) {
            this.#logger.warn({ parseErr }, 'Failed to parse Vartaloop message');
            continue;
          }

          const head = pending[0];

          if (event.type === 'error') {
            // Only our own utterance's error, or an untagged connection-level one, fails the
            // turn; an error left over from a previous turn on a pooled socket is dropped.
            if (event.request_id && event.request_id !== head?.utteranceId) continue;
            throw statusError(event.status ?? 500, event.error ?? 'unknown error', {
              requestId: event.request_id ?? requestId,
              retryAfter: event.retry_after,
            });
          }

          if (!head || event.request_id !== head.utteranceId) {
            // An event of an utterance that is not ours (left over on a pooled socket).
            continue;
          }

          if (event.type === 'start') {
            currentUtterance = head.utteranceId;
            if (currentSegment !== head.segmentId) {
              // A new segment: close the frames of the previous one.
              if (currentSegment !== undefined) {
                pushFrames(bstream.flush(), currentSegment);
                sendLastFrame(true);
              }
              currentSegment = head.segmentId;
            }
            this.noteProviderRequestId(head.utteranceId);
          } else if (event.type === 'end') {
            pending.shift();
            // The utterance's audio is complete: hand over its tail without waiting for the
            // next sentence's first frame to pad it.
            pushFrames(bstream.flush(), currentSegment ?? head.segmentId);
            currentUtterance = undefined;
            const next = pending[0];
            if (next && next.segmentId !== currentSegment) {
              // The sentence closed its segment: its last frame is the segment's final one.
              sendLastFrame(true);
              currentSegment = undefined;
            } else if (next) {
              // The segment goes on with the next sentence: nothing more comes for this one, so
              // its tail is handed over now rather than held until the next frame.
              sendLastFrame(false);
            }
            if (senderDone && pending.length === 0) {
              finish();
              break;
            }
            if (pending.length === 0) clearWatchdog();
          }
          // chunk, first_audio_ms, chunk_end: progress only
        }

        if (timedOut) {
          throw new APITimeoutError({
            message: `Vartaloop TTS chunk stream timed out after ${this.#opts.chunkTimeout}ms`,
          });
        }
        if (streamError) {
          throw streamError;
        }
        if (!completed && !this.abortController.signal.aborted) {
          throw new APIConnectionError({ message: 'Vartaloop WebSocket closed mid-generation' });
        }
      } finally {
        // A failed attempt drops the frame it was holding: either nothing was spoken yet and the
        // retry re-sends the sentence from its start, or audio was already heard and the turn
        // ends here (see `#audioEmitted`); in neither case is the held frame played.
        if (!completed) lastFrame = undefined;
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        clearWatchdog();
      }
    };

    try {
      // The pool hands back one live socket per call and reclaims it on success (put) or
      // discards it on any thrown error or abort (remove): the server keeps streaming an
      // interrupted utterance on the socket, so it must not serve the next turn.
      await this.#pool.withConnection(
        async (ws) => {
          if (ws.readyState !== WebSocket.OPEN) {
            throw new APIConnectionError({ message: 'Vartaloop pooled websocket is not open' });
          }
          socket = ws;
          await Promise.all([inputTask(), sendTask(ws), recvTask(ws)]);
        },
        { timeout: this.connOptions.timeoutMs, signal: this.abortSignal },
      );
    } catch (e) {
      if (this.abortSignal.aborted) {
        return;
      }
      const error = e instanceof APIError ? e : toRetryableConnectionError(e);
      // Once audio has been emitted a retry would repeat the start of the interrupted sentence
      // (a retry re-sends whole utterances, and the server has no resume), so the failure is
      // final. Before any audio the retry is clean: the same sentences are sent again.
      throw this.#audioEmitted ? asFinalError(error) : error;
    } finally {
      attemptOver = true;
      this.#wakeInputReaders();
      clearWatchdog();
      void eventChannel.close();
    }
  }
}

// The same error, marked not retryable, for a failure after audio was already heard.
const asFinalError = (error: APIError): APIError => {
  if (!error.retryable) return error;
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
  if (error instanceof APITimeoutError) {
    return new APITimeoutError({ message: error.message, options: { retryable: false } });
  }
  return new APIConnectionError({ message: error.message, options: { retryable: false } });
};

const authHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  'User-Agent': USER_AGENT,
});

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const toBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

/**
 * An API error with the server's status. 503 (every worker busy, retry after `Retry-After`) and
 * 5xx are retryable; 4xx (bad text, voice, key, credits) are not.
 */
const statusError = (
  status: number,
  message: string,
  { requestId, retryAfter }: { requestId: string | null; retryAfter?: string | number },
): APIStatusError => {
  let body: object | string = message;
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed !== null && typeof parsed === 'object') {
      body = parsed;
      const error = (parsed as { error?: unknown }).error;
      if (error !== undefined) message = String(error);
    }
  } catch {
    // a plain-text body is its own message
  }
  if (retryAfter !== undefined && retryAfter !== null) {
    message = `${message} (retry after ${retryAfter}s)`;
  }
  return new APIStatusError({
    message: `Vartaloop returned error: ${message}`,
    options: { statusCode: status, requestId, body, retryable: status >= 500 },
  });
};

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

const sanitizedErrorName = (error: Error): string => {
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof AggregateError) return 'AggregateError';
  return 'Error';
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
    ? 'Vartaloop connection timed out'
    : `Vartaloop connection failed: ${err.message || 'unknown error'}`;
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
    ws.off('unexpected-response', onUnexpectedResponse);
    ws.off('error', onError);
    ws.off('close', onClose);
    abortSignal?.removeEventListener('abort', onAbort);
  };

  const onOpen = () => fut.resolve();
  const onError = (err: Error) => fut.reject(asError(err));
  const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
    // The handshake request carries the Authorization header: keep the status only.
    const statusCode = response.statusCode ?? -1;
    fut.reject(
      new APIStatusError({
        message: `Vartaloop WebSocket connection rejected with status ${statusCode}`,
        options: { statusCode },
      }),
    );
  };
  const onClose = (code: number, reason: Buffer) =>
    fut.reject(
      new Error(`WebSocket closed before open (code=${code}, reason=${reason.toString()})`),
    );
  const onAbort = () => fut.reject(new Error('aborted'));

  ws.on('open', onOpen);
  ws.on('unexpected-response', onUnexpectedResponse);
  ws.on('error', onError);
  ws.on('close', onClose);
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  if (timeoutMs > 0) {
    timeout = setTimeout(
      () =>
        fut.reject(new APITimeoutError({ message: 'Vartaloop WebSocket connection timed out' })),
      timeoutMs,
    );
  }

  try {
    await fut.await;
  } finally {
    cleanup();
  }
};

const safeTerminateWebSocket = (ws: WebSocket) => {
  // `ws` can emit 'error' during teardown (especially if CONNECTING); without a listener Node
  // treats it as unhandled and crashes the process.
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

// Graceful close used by the connection pool. A pooled socket is healthy when it is retired
// (session age, option change, or TTS close), so a clean close frame is preferable to an abrupt
// terminate; terminate remains the fallback for a socket caught mid-handshake.
const safeCloseWebSocket = (ws: WebSocket) => {
  try {
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

const connectWebSocket = async ({
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

  let connectError: unknown;
  try {
    return await connectOnce();
  } catch (e) {
    connectError = e;
    // Mitigation for Node.js dual-stack (IPv6/IPv4) connect flakiness ("happy eyeballs"): some
    // environments surface `AggregateError` with nested `ETIMEDOUT` during the initial WebSocket
    // open. Retry once forcing IPv4 before letting the outer retry loop handle further attempts.
    if (!(e instanceof APIError) && (hasAnyTransientCode(e) || isAggregateErrorLike(e))) {
      try {
        return await connectOnce(4);
      } catch (retryError) {
        connectError = retryError;
      }
    }
  }

  if (connectError instanceof APIError) throw connectError;
  const error = asError(connectError);
  const isTimeout =
    hasErrorCode(connectError, 'ETIMEDOUT') || /timed?\s*out|timeout/i.test(error.message);
  if (isTimeout) {
    throw new APITimeoutError({ message: 'Vartaloop WebSocket connection timed out' });
  }
  // Transport errors can quote the URL (which may carry a key): keep the type only.
  throw new APIConnectionError({ message: sanitizedErrorName(error) });
};

/**
 * The JSON of one utterance, shared by the REST and the WebSocket path.
 *
 * Only fields that differ from the server's defaults are sent, so the request log stays readable
 * and the server's own default for anything unset keeps applying. The API has no `model` field.
 *
 * @internal
 */
export const _toVartaloopBody = (
  opts: TTSOptions,
  text: string,
  requestId: string,
): { [id: string]: unknown } => {
  const body: { [id: string]: unknown } = {
    text,
    voice: opts.voice,
    format: 'pcm16',
    request_id: requestId,
  };
  if (opts.expression && opts.expression !== 'neutral') {
    body.style = opts.expression;
  }
  if (opts.digits) {
    body.digits = opts.digits;
  }
  if (opts.speed !== undefined) {
    body.speed = opts.speed;
  }
  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }
  if (opts.seed !== undefined) {
    body.seed = opts.seed;
  }
  if (opts.postfx !== undefined) {
    body.postfx = opts.postfx;
  }
  if (opts.profile !== undefined && opts.profile !== 'default') {
    body.profile = opts.profile;
  }
  if (opts.raw) {
    body.raw = true;
  }
  return body;
};
