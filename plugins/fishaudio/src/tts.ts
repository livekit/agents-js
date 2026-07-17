// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  ConnectionPool,
  Future,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import { decode, encode } from '@msgpack/msgpack';
import { request } from 'node:https';
import { type RawData, WebSocket } from 'ws';
import type { LatencyMode, MP3Bitrate, OpusBitrate, TTSModels } from './models.js';

const DEFAULT_MODEL: TTSModels = 's2.1-pro';
const DEFAULT_VOICE_ID = '933563129e564b19a115bedd57b7406a';
const DEFAULT_BASE_URL = 'https://api.fish.audio';
const NUM_CHANNELS = 1;
// Fish Audio's default sample rate for raw PCM output.
const DEFAULT_SAMPLE_RATE = 24000;

const connectionPools = new WeakMap<TTS, ConnectionPool<WebSocket>>();

/** @public */
export interface TTSOptions {
  apiKey?: string;
  model?: TTSModels | string;
  voiceId?: string;
  sampleRate?: number;
  baseURL?: string;
  latencyMode?: LatencyMode;
  /**
   * Upper bound on the number of characters Fish buffers before auto-synthesizing.
   * Must be between 100 and 300. With sentence-level flushing this is only hit by
   * sentences longer than `chunkLength`; otherwise audio is produced as soon as
   * each sentence is flushed. Defaults to 100.
   */
  chunkLength?: number;
  /**
   * Speaking rate multiplier for Fish `prosody.speed`. `1.0` is normal; below
   * 1.0 is slower, above is faster. Unset uses the voice's natural pace.
   */
  speed?: number;
  /**
   * Loudness adjustment in decibels for Fish `prosody.volume`. `0` is the
   * voice's natural level. Unset leaves it unchanged.
   */
  volume?: number;
  /**
   * Sampling temperature (0-1). Higher values produce more varied, expressive
   * speech; lower values are more stable. Defaults to 0.7.
   */
  temperature?: number;
  /** Nucleus sampling probability mass (0-1). Defaults to 0.7. */
  topP?: number;
  /** MP3 bitrate in kbps: 64, 128, or 192. Defaults to 64. */
  mp3Bitrate?: MP3Bitrate;
  /** Opus bitrate in bps: -1000 (auto), 24000, 32000, 48000, or 64000. Defaults to 64000. */
  opusBitrate?: OpusBitrate;
  /** Whether Fish normalizes the input text before synthesis. Defaults to true. */
  normalize?: boolean;
  tokenizer?: tokenize.SentenceTokenizer;
}

interface ResolvedTTSOptions {
  apiKey: string;
  model: TTSModels | string;
  voiceId?: string;
  sampleRate: number;
  baseURL: string;
  latencyMode: LatencyMode;
  chunkLength: number;
  speed?: number;
  volume?: number;
  temperature: number;
  topP: number;
  mp3Bitrate: MP3Bitrate;
  opusBitrate: OpusBitrate;
  normalize: boolean;
  tokenizer: tokenize.SentenceTokenizer;
}

const DEFAULT_OPTS: Omit<ResolvedTTSOptions, 'apiKey' | 'tokenizer'> = {
  model: DEFAULT_MODEL,
  voiceId: DEFAULT_VOICE_ID,
  sampleRate: DEFAULT_SAMPLE_RATE,
  baseURL: DEFAULT_BASE_URL,
  latencyMode: 'balanced',
  chunkLength: 100,
  temperature: 0.7,
  topP: 0.7,
  mp3Bitrate: 64,
  opusBitrate: 64000,
  normalize: true,
};

const validateChunkLength = (chunkLength: number) => {
  if (!Number.isFinite(chunkLength) || chunkLength < 100 || chunkLength > 300) {
    throw new Error('chunkLength must be between 100 and 300');
  }
};

const validateProbability = (name: string, value: number) => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
};

// Fish Audio's wire format mirrors the upstream Python SDK so the server
// doesn't fall back to its own larger defaults — in particular the docs default
// of `chunk_length=300` produces large bursts that leave audible gaps between
// chunk boundaries.
const buildTtsRequest = (opts: ResolvedTTSOptions, text: string = ''): Record<string, unknown> => {
  const prosody =
    opts.speed !== undefined || opts.volume !== undefined
      ? {
          ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
          ...(opts.volume !== undefined ? { volume: opts.volume } : {}),
        }
      : null;

  return {
    text,
    chunk_length: opts.chunkLength,
    format: 'pcm',
    sample_rate: opts.sampleRate,
    mp3_bitrate: opts.mp3Bitrate,
    opus_bitrate: opts.opusBitrate,
    references: [],
    // Fish Audio's wire field is `reference_id`; we expose it as `voiceId` on
    // the plugin for consistency with other TTS plugins.
    reference_id: opts.voiceId ?? null,
    normalize: opts.normalize,
    latency: opts.latencyMode,
    prosody,
    top_p: opts.topP,
    temperature: opts.temperature,
  };
};

/** @public */
export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  #pool: ConnectionPool<WebSocket>;
  #closed = false;
  label = 'fishaudio.TTS';

  constructor(opts: TTSOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.FISH_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Fish Audio API key is required, either as argument or set FISH_API_KEY environment variable',
      );
    }

    const chunkLength = opts.chunkLength ?? DEFAULT_OPTS.chunkLength;
    validateChunkLength(chunkLength);

    const temperature = opts.temperature ?? DEFAULT_OPTS.temperature;
    validateProbability('temperature', temperature);
    const topP = opts.topP ?? DEFAULT_OPTS.topP;
    validateProbability('topP', topP);

    const sampleRate = opts.sampleRate ?? DEFAULT_OPTS.sampleRate;

    super(sampleRate, NUM_CHANNELS, { streaming: true });

    // min_sentence_len=1 emits each sentence as soon as the next one starts,
    // rather than batching short sentences together — minimizes TTFB on the
    // first sentence and keeps Fish synthesizing continuously.
    const tokenizer =
      opts.tokenizer ?? new tokenize.basic.SentenceTokenizer({ minSentenceLength: 1 });

    this.#opts = {
      apiKey,
      model: opts.model ?? DEFAULT_OPTS.model,
      voiceId: opts.voiceId ?? DEFAULT_OPTS.voiceId,
      sampleRate,
      baseURL: opts.baseURL ?? DEFAULT_OPTS.baseURL,
      latencyMode: opts.latencyMode ?? DEFAULT_OPTS.latencyMode,
      chunkLength,
      speed: opts.speed,
      volume: opts.volume,
      temperature,
      topP,
      mp3Bitrate: opts.mp3Bitrate ?? DEFAULT_OPTS.mp3Bitrate,
      opusBitrate: opts.opusBitrate ?? DEFAULT_OPTS.opusBitrate,
      normalize: opts.normalize ?? DEFAULT_OPTS.normalize,
      tokenizer,
    };

    this.#pool = new ConnectionPool<WebSocket>({
      connectCb: (timeoutMs) => this.#connectWebSocket(timeoutMs),
      closeCb: async (ws) => closeWebSocket(ws),
      maxSessionDuration: 300_000,
      markRefreshedOnGet: true,
    });
    connectionPools.set(this, this.#pool);
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'FishAudio';
  }

  updateOptions(opts: {
    model?: TTSModels | string;
    voiceId?: string;
    latencyMode?: LatencyMode;
    chunkLength?: number;
    speed?: number;
    volume?: number;
    temperature?: number;
    topP?: number;
    mp3Bitrate?: MP3Bitrate;
    opusBitrate?: OpusBitrate;
    normalize?: boolean;
  }): void {
    if (opts.model !== undefined && opts.model !== this.#opts.model) {
      this.#opts.model = opts.model;
      // The model is sent as a connection header at ws-handshake time, not in the
      // per-request body, so a pooled socket keeps the old model.
      this.#pool.invalidate();
    }
    if (opts.voiceId !== undefined) this.#opts.voiceId = opts.voiceId;
    if (opts.latencyMode !== undefined) this.#opts.latencyMode = opts.latencyMode;
    if (opts.chunkLength !== undefined) {
      validateChunkLength(opts.chunkLength);
      this.#opts.chunkLength = opts.chunkLength;
    }
    if (opts.speed !== undefined) this.#opts.speed = opts.speed;
    if (opts.volume !== undefined) this.#opts.volume = opts.volume;
    if (opts.temperature !== undefined) {
      validateProbability('temperature', opts.temperature);
      this.#opts.temperature = opts.temperature;
    }
    if (opts.topP !== undefined) {
      validateProbability('topP', opts.topP);
      this.#opts.topP = opts.topP;
    }
    if (opts.mp3Bitrate !== undefined) this.#opts.mp3Bitrate = opts.mp3Bitrate;
    if (opts.opusBitrate !== undefined) this.#opts.opusBitrate = opts.opusBitrate;
    if (opts.normalize !== undefined) this.#opts.normalize = opts.normalize;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SynthesizeStream(this, this.#opts, options?.connOptions);
  }

  prewarm(): void {
    this.#pool.prewarm();
  }

  override async close(): Promise<void> {
    this.#closed = true;
    await this.#pool.close();
    await super.close();
  }

  async #connectWebSocket(timeoutMs: number): Promise<WebSocket> {
    const wsUrl = `${this.#opts.baseURL.replace(/^http/, 'ws')}/v1/tts/live`;
    const model = this.#opts.model;
    const ws = await connectWebSocket({
      url: wsUrl,
      headers: {
        Authorization: `Bearer ${this.#opts.apiKey}`,
        model,
      },
      timeoutMs,
    });
    if (this.#closed) {
      closeWebSocket(ws);
      throw new APIConnectionError({ message: 'Fish Audio TTS is closed' });
    }
    if (model !== this.#opts.model) {
      closeWebSocket(ws);
      return await this.#connectWebSocket(timeoutMs);
    }
    return ws;
  }
}

/** @public */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'fishaudio.ChunkedStream';
  #logger = log();
  #opts: ResolvedTTSOptions;
  #text: string;

  constructor(
    tts: TTS,
    text: string,
    opts: ResolvedTTSOptions,
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
    const payload = encode(buildTtsRequest(this.#opts, this.#text));

    const baseUrl = new URL(this.#opts.baseURL);
    const isHttps = baseUrl.protocol === 'https:';
    if (!isHttps) {
      // The plugin only supports https; fall back via Node's http module is
      // intentionally not implemented to keep the code path simple.
      throw new APIConnectionError({
        message: `Fish Audio base URL must use https (got ${this.#opts.baseURL})`,
      });
    }

    const doneFut = new Future<void>();

    const req = request(
      {
        hostname: baseUrl.hostname,
        port: parseInt(baseUrl.port) || 443,
        path: '/v1/tts',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          'Content-Type': 'application/msgpack',
          model: this.#opts.model,
          'Content-Length': payload.byteLength,
        },
        signal: this.abortSignal,
      },
      (res) => {
        const status = res.statusCode ?? -1;
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (!doneFut.done) {
              doneFut.reject(
                new APIStatusError({
                  message: `Fish Audio TTS request failed: ${body}`,
                  options: { statusCode: status, body: { raw: body } },
                }),
              );
            }
          });
          res.on('error', (err) => {
            if (err.message === 'aborted') return;
            this.#logger.error({ err }, 'Fish Audio TTS error response stream error');
            if (!doneFut.done) {
              doneFut.reject(
                new APIStatusError({
                  message: `Fish Audio TTS request failed (status ${status})`,
                  options: { statusCode: status },
                }),
              );
            }
          });
          return;
        }

        res.on('data', (chunk: Buffer) => {
          for (const frame of bstream.write(chunk)) {
            this.queue.put({
              requestId,
              segmentId: requestId,
              frame,
              final: false,
            });
          }
        });
        res.on('close', () => {
          for (const frame of bstream.flush()) {
            this.queue.put({
              requestId,
              segmentId: requestId,
              frame,
              final: false,
            });
          }
          if (!this.queue.closed) this.queue.close();
          if (!doneFut.done) doneFut.resolve();
        });
        res.on('error', (err) => {
          if (err.message === 'aborted') return;
          this.#logger.error({ err }, 'Fish Audio TTS response error');
          if (!doneFut.done) doneFut.reject(err);
        });
      },
    );

    req.on('error', (err) => {
      if (err.name === 'AbortError') return;
      this.#logger.error({ err }, 'Fish Audio TTS request error');
      if (!doneFut.done) doneFut.reject(err);
    });
    req.write(payload);
    req.end();

    try {
      await doneFut.await;
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (!this.queue.closed) this.queue.close();
      if (e instanceof APIStatusError || e instanceof APIConnectionError) {
        throw e;
      }
      throw new APIConnectionError({
        message: `Fish Audio connection failed: ${(e as Error).message ?? 'unknown error'}`,
      });
    }
  }
}

/** @public */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'fishaudio.SynthesizeStream';
  #logger = log();
  #pool: ConnectionPool<WebSocket>;
  #opts: ResolvedTTSOptions;

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    const pool = connectionPools.get(tts);
    if (!pool) throw new Error('Fish Audio connection pool is not initialized');
    this.#pool = pool;
    this.#opts = opts;
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

    // Tokenize incoming text by sentence and flush after each sentence so Fish
    // synthesizes immediately at sentence boundaries instead of waiting for
    // `chunkLength` characters to accumulate. The result is much smoother
    // audio: gaps line up with sentence breaks (where pauses are natural)
    // rather than mid-clause.
    const sentStream = this.#opts.tokenizer.stream();

    const finished = new Future<void>();

    const inputTask = async () => {
      try {
        for await (const data of this.input) {
          if (this.abortController.signal.aborted) break;
          if (data === SynthesizeStream.FLUSH_SENTINEL) {
            sentStream.flush();
            continue;
          }
          if (!data) continue;
          sentStream.pushText(data);
        }
      } finally {
        if (!sentStream.closed) sentStream.endInput();
      }
    };

    const sendTask = async (ws: WebSocket) => {
      const startMsg = { event: 'start', request: buildTtsRequest(this.#opts) };
      ws.send(Buffer.from(encode(startMsg)));

      for await (const ev of sentStream) {
        if (this.abortController.signal.aborted) break;
        const sentence = ev.token;
        if (!sentence) continue;
        this.markStarted();
        ws.send(Buffer.from(encode({ event: 'text', text: sentence + ' ' })));
        ws.send(Buffer.from(encode({ event: 'flush' })));
      }

      if (!this.abortController.signal.aborted) {
        ws.send(Buffer.from(encode({ event: 'stop' })));
      }
    };

    const recvTask = async (ws: WebSocket) => {
      // No per-receive timeout: Fish has natural inter-sentence gaps that can
      // exceed connOptions.timeoutMs when the LLM is slow.
      const onMessage = (raw: RawData) => {
        let frame: Buffer;
        if (Buffer.isBuffer(raw)) {
          frame = raw;
        } else if (Array.isArray(raw)) {
          frame = Buffer.concat(raw);
        } else {
          frame = Buffer.from(raw as ArrayBuffer);
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = decode(frame) as Record<string, unknown>;
        } catch (err) {
          this.#logger.warn({ err }, 'Fish Audio failed to decode message');
          return;
        }

        const event = parsed.event as string | undefined;
        if (event === 'audio') {
          const audio = parsed.audio as Uint8Array | undefined;
          if (audio && audio.byteLength > 0) {
            for (const frame of bstream.write(audio)) {
              this.queue.put({ requestId, segmentId: requestId, frame, final: false });
            }
          }
        } else if (event === 'finish') {
          const reason = parsed.reason as string | undefined;
          if (reason === 'error') {
            finished.reject(
              new APIStatusError({
                message: 'Fish Audio TTS reported an error',
                options: { body: { raw: JSON.stringify(parsed) } },
              }),
            );
            return;
          }
          const remainingFrames = [...bstream.flush()];
          for (const [idx, frame] of remainingFrames.entries()) {
            this.queue.put({
              requestId,
              segmentId: requestId,
              frame,
              final: idx === remainingFrames.length - 1,
            });
          }
          if (!this.queue.closed) {
            this.queue.put(SynthesizeStream.END_OF_STREAM);
          }
          if (!finished.done) finished.resolve();
        } else {
          this.#logger.debug({ event }, 'unknown Fish Audio event');
        }
      };

      const onClose = (code: number, reason: Buffer) => {
        if (!finished.done) {
          finished.reject(
            new APIStatusError({
              message: 'Fish Audio websocket connection closed unexpectedly',
              options: {
                statusCode: code || -1,
                body: { reason: reason.toString() },
              },
            }),
          );
        }
      };

      const onError = (err: Error) => {
        if (!finished.done) finished.reject(err);
      };

      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);

      try {
        await finished.await;
      } finally {
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
      }
    };

    try {
      await this.#pool.withConnection(
        async (ws) => {
          if (ws.readyState !== WebSocket.OPEN) {
            throw new APIConnectionError({
              message: 'Fish Audio pooled websocket is not open',
            });
          }
          await Promise.all([inputTask(), sendTask(ws), recvTask(ws)]);
        },
        { timeout: this.connOptions.timeoutMs, signal: this.abortSignal },
      );
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (e instanceof APIStatusError || e instanceof APIConnectionError) {
        throw e;
      }
      throw new APIConnectionError({
        message: `Fish Audio websocket failed: ${(e as Error).message ?? 'unknown error'}`,
      });
    } finally {
      if (!sentStream.closed) sentStream.close();
    }
  }
}

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
  const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs });
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
  const onError = (err: Error) => fut.reject(err);
  const onClose = (code: number, reason: Buffer) =>
    fut.reject(
      new Error(`websocket closed before open (code=${code}, reason=${reason.toString()})`),
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
    return ws;
  } catch (e) {
    try {
      closeWebSocket(ws);
    } catch {
      // ignore
    }
    throw e;
  } finally {
    cleanup();
  }
};

const closeWebSocket = (ws: WebSocket) => {
  try {
    ws.on('error', () => {});
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      ws.close();
    } else if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      ws.terminate();
    }
  } catch {
    // ignore
  }
};
