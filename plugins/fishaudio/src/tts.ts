// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  Future,
  log,
  shortuuid,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { decode, encode } from '@msgpack/msgpack';
import { request } from 'node:https';
import { type RawData, WebSocket } from 'ws';
import type { LatencyMode, TTSModels } from './models.js';

const DEFAULT_MODEL: TTSModels = 's2-pro';
const DEFAULT_VOICE_ID = '933563129e564b19a115bedd57b7406a';
const DEFAULT_BASE_URL = 'https://api.fish.audio';
const NUM_CHANNELS = 1;
// Fish Audio's default sample rate for raw PCM output.
const DEFAULT_SAMPLE_RATE = 24000;

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
  tokenizer: tokenize.SentenceTokenizer;
}

const DEFAULT_OPTS: Omit<ResolvedTTSOptions, 'apiKey' | 'tokenizer'> = {
  model: DEFAULT_MODEL,
  voiceId: DEFAULT_VOICE_ID,
  sampleRate: DEFAULT_SAMPLE_RATE,
  baseURL: DEFAULT_BASE_URL,
  latencyMode: 'balanced',
  chunkLength: 100,
};

const validateChunkLength = (chunkLength: number) => {
  if (!Number.isFinite(chunkLength) || chunkLength < 100 || chunkLength > 300) {
    throw new Error('chunkLength must be between 100 and 300');
  }
};

// Fish Audio's wire format mirrors the upstream Python SDK so the server
// doesn't fall back to its own larger defaults — in particular the docs default
// of `chunk_length=300` produces large bursts that leave audible gaps between
// chunk boundaries.
const buildTtsRequest = (opts: ResolvedTTSOptions, text: string = ''): Record<string, unknown> => ({
  text,
  chunk_length: opts.chunkLength,
  format: 'pcm',
  sample_rate: opts.sampleRate,
  mp3_bitrate: 64,
  opus_bitrate: 64000,
  references: [],
  // Fish Audio's wire field is `reference_id`; we expose it as `voiceId` on
  // the plugin for consistency with other TTS plugins.
  reference_id: opts.voiceId ?? null,
  normalize: true,
  latency: opts.latencyMode,
  prosody: null,
  top_p: 0.7,
  temperature: 0.7,
});

export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
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
      tokenizer,
    };
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
  }): void {
    if (opts.model !== undefined) this.#opts.model = opts.model;
    if (opts.voiceId !== undefined) this.#opts.voiceId = opts.voiceId;
    if (opts.latencyMode !== undefined) this.#opts.latencyMode = opts.latencyMode;
    if (opts.chunkLength !== undefined) {
      validateChunkLength(opts.chunkLength);
      this.#opts.chunkLength = opts.chunkLength;
    }
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
}

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

export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'fishaudio.SynthesizeStream';
  #logger = log();
  #opts: ResolvedTTSOptions;

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
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

    const wsUrl = `${this.#opts.baseURL.replace(/^http/, 'ws')}/v1/tts/live`;
    let ws: WebSocket | undefined;
    try {
      ws = await connectWebSocket({
        url: wsUrl,
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          model: this.#opts.model,
        },
        timeoutMs: this.connOptions.timeoutMs,
        abortSignal: this.abortSignal,
      });
    } catch (e) {
      throw new APIConnectionError({
        message: `Fish Audio websocket connect failed: ${(e as Error).message ?? 'unknown error'}`,
      });
    }

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

    const sendTask = async () => {
      const startMsg = { event: 'start', request: buildTtsRequest(this.#opts) };
      ws!.send(Buffer.from(encode(startMsg)));

      for await (const ev of sentStream) {
        if (this.abortController.signal.aborted) break;
        const sentence = ev.token;
        if (!sentence) continue;
        ws!.send(Buffer.from(encode({ event: 'text', text: sentence + ' ' })));
        ws!.send(Buffer.from(encode({ event: 'flush' })));
      }

      if (!this.abortController.signal.aborted) {
        ws!.send(Buffer.from(encode({ event: 'stop' })));
      }
    };

    let lastFrame: AudioFrame | undefined;
    const sendLastFrame = (final: boolean) => {
      if (lastFrame) {
        this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
        lastFrame = undefined;
      }
    };

    const recvTask = async () => {
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
            for (const f of bstream.write(audio)) {
              sendLastFrame(false);
              lastFrame = f;
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
          for (const f of bstream.flush()) {
            sendLastFrame(false);
            lastFrame = f;
          }
          sendLastFrame(true);
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

      ws!.on('message', onMessage);
      ws!.on('close', onClose);
      ws!.on('error', onError);

      try {
        await finished.await;
      } finally {
        ws!.off('message', onMessage);
        ws!.off('close', onClose);
        ws!.off('error', onError);
      }
    };

    try {
      await Promise.all([inputTask(), sendTask(), recvTask()]);
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
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
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
  abortSignal: AbortSignal;
}): Promise<WebSocket> => {
  const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs });
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
  const onError = (err: Error) => fut.reject(err);
  const onClose = (code: number, reason: Buffer) =>
    fut.reject(
      new Error(`websocket closed before open (code=${code}, reason=${reason.toString()})`),
    );
  const onAbort = () => fut.reject(new Error('aborted'));

  ws.on('open', onOpen);
  ws.on('error', onError);
  ws.on('close', onClose);
  abortSignal.addEventListener('abort', onAbort, { once: true });

  if (timeoutMs > 0) {
    timeout = setTimeout(() => fut.reject(new Error('connect timeout')), timeoutMs);
  }

  try {
    await fut.await;
    return ws;
  } catch (e) {
    try {
      ws.on('error', () => {});
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      } else {
        ws.terminate();
      }
    } catch {
      // ignore
    }
    throw e;
  } finally {
    cleanup();
  }
};
