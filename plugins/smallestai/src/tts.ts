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
  normalizeLanguage,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { request } from 'node:https';
import { type RawData, WebSocket } from 'ws';
import type { TTSEncoding, TTSModels } from './models.js';

const NUM_CHANNELS = 1;
const DEFAULT_BASE_URL = 'https://api.smallest.ai/waves/v1';
const DEFAULT_WS_URL = 'wss://api.smallest.ai/waves/v1/tts/live';

/** @public */
export interface TTSOptions {
  apiKey?: string;
  model?: TTSModels | string;
  voiceId?: string;
  sampleRate?: number;
  speed?: number;
  language?: string;
  outputFormat?: TTSEncoding | string;
  baseURL?: string;
  wsURL?: string;
}

/** @public */
export interface ResolvedTTSOptions {
  apiKey: string;
  model: TTSModels | string;
  voiceId: string;
  sampleRate: number;
  speed: number;
  language: string;
  outputFormat: TTSEncoding | string;
  baseURL: string;
  wsURL: string;
}

const resolveVoiceId = (model: TTSModels | string, voiceId?: string): string => {
  if (voiceId) return voiceId;
  return model === 'lightning_v3.1_pro' ? 'meher' : 'sophia';
};

const toSmallestOptions = (opts: ResolvedTTSOptions): Record<string, unknown> => ({
  model: opts.model,
  voice_id: opts.voiceId,
  sample_rate: opts.sampleRate,
  speed: opts.speed,
  language: opts.language,
  output_format: opts.outputFormat,
});

const commonHeaders = (opts: ResolvedTTSOptions): Record<string, string> => ({
  Authorization: `Bearer ${opts.apiKey}`,
  'X-Source': 'livekit',
  'X-LiveKit-Version': __PACKAGE_VERSION__,
});

/** @public */
export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  label = 'smallestai.TTS';

  constructor(opts: TTSOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.SMALLEST_API_KEY;
    if (!apiKey) {
      throw new Error(
        'SmallestAI API key is required, either as argument or set SMALLEST_API_KEY environment variable',
      );
    }

    const model = opts.model ?? 'lightning_v3.1_pro';
    const sampleRate = opts.sampleRate ?? 24000;

    super(sampleRate, NUM_CHANNELS, { streaming: true });

    this.#opts = {
      apiKey,
      model,
      voiceId: resolveVoiceId(model, opts.voiceId),
      sampleRate,
      speed: opts.speed ?? 1.0,
      language: normalizeLanguage(opts.language ?? 'en'),
      outputFormat: opts.outputFormat ?? 'pcm',
      baseURL: opts.baseURL ?? DEFAULT_BASE_URL,
      wsURL: opts.wsURL ?? DEFAULT_WS_URL,
    };
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'SmallestAI';
  }

  updateOptions(opts: {
    model?: TTSModels | string;
    voiceId?: string;
    speed?: number;
    language?: string;
    outputFormat?: TTSEncoding | string;
  }): void {
    const model = opts.model ?? this.#opts.model;
    this.#opts = {
      ...this.#opts,
      ...opts,
      model,
      voiceId: opts.voiceId ?? (opts.model ? resolveVoiceId(model) : this.#opts.voiceId),
      language: opts.language ? normalizeLanguage(opts.language) : this.#opts.language,
    };
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

/** @public */
export class ChunkedStream extends tts.ChunkedStream {
  label = 'smallestai.ChunkedStream';
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
    this.#opts = { ...opts };
  }

  protected async run() {
    if (this.#opts.outputFormat !== 'pcm') {
      throw new APIConnectionError({
        message: 'SmallestAI agents-js TTS currently requires outputFormat="pcm"',
        options: { retryable: false },
      });
    }

    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    const payload = { ...toSmallestOptions(this.#opts), text: this.#text };
    const baseURL = new URL(this.#opts.baseURL);
    const done = new Future<void>();

    const req = request(
      {
        hostname: baseURL.hostname,
        port: parseInt(baseURL.port) || 443,
        path: `${baseURL.pathname.replace(/\/$/, '')}/tts`,
        method: 'POST',
        headers: {
          ...commonHeaders(this.#opts),
          'Content-Type': 'application/json',
        },
        signal: this.abortSignal,
      },
      (res) => {
        const status = res.statusCode ?? -1;
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            if (!done.done) {
              done.reject(
                new APIStatusError({
                  message: `SmallestAI TTS request failed: ${body}`,
                  options: { statusCode: status, body: { raw: body } },
                }),
              );
            }
          });
          return;
        }

        res.on('data', (chunk: Buffer) => {
          for (const frame of bstream.write(chunk)) {
            this.queue.put({ requestId, segmentId: requestId, frame, final: false });
          }
        });
        res.on('close', () => {
          for (const frame of bstream.flush()) {
            this.queue.put({ requestId, segmentId: requestId, frame, final: false });
          }
          if (!this.queue.closed) this.queue.close();
          if (!done.done) done.resolve();
        });
        res.on('error', (err) => {
          if (err.message === 'aborted') return;
          this.#logger.error({ err }, 'SmallestAI TTS response error');
          if (!done.done) done.reject(err);
        });
      },
    );

    req.on('error', (err) => {
      if (err.name === 'AbortError') return;
      this.#logger.error({ err }, 'SmallestAI TTS request error');
      if (!done.done) done.reject(err);
    });
    req.write(JSON.stringify(payload));
    req.end();

    try {
      await done.await;
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (!this.queue.closed) this.queue.close();
      if (e instanceof APIStatusError || e instanceof APIConnectionError) throw e;
      throw new APIConnectionError({
        message: `SmallestAI connection failed: ${(e as Error).message ?? 'unknown error'}`,
      });
    }
  }
}

/** @public */
export class SynthesizeStream extends tts.SynthesizeStream {
  label = 'smallestai.SynthesizeStream';
  #opts: ResolvedTTSOptions;
  #logger = log();

  constructor(tts: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = { ...opts };
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);

    let textBuffer = '';
    for await (const data of this.input) {
      if (this.abortController.signal.aborted) break;

      if (data === SynthesizeStream.FLUSH_SENTINEL) {
        const text = textBuffer.trim();
        textBuffer = '';
        if (text) await this.synthesizeSegment(text, requestId, bstream);
        continue;
      }

      textBuffer += data;
    }

    if (!this.queue.closed) {
      this.queue.put(SynthesizeStream.END_OF_STREAM);
    }
  }

  private async synthesizeSegment(
    text: string,
    requestId: string,
    bstream: AudioByteStream,
  ): Promise<void> {
    const segmentId = shortuuid();
    const ws = await connectWebSocket({
      url: this.#opts.wsURL,
      headers: commonHeaders(this.#opts),
      timeoutMs: this.connOptions.timeoutMs,
      abortSignal: this.abortSignal,
    });

    const finished = new Future<void>();
    let lastFrame: AudioFrame | undefined;

    const sendLastFrame = (final: boolean) => {
      if (!lastFrame) return;
      this.queue.put({ requestId, segmentId, frame: lastFrame, final });
      lastFrame = undefined;
    };

    const onMessage = (raw: RawData) => {
      try {
        const data = rawDataToString(raw);
        const event = JSON.parse(data) as {
          status?: string;
          data?: { audio?: string };
          message?: string;
        };

        if (event.status === 'chunk') {
          const audio = event.data?.audio;
          if (!audio) return;
          for (const frame of bstream.write(Buffer.from(audio, 'base64'))) {
            sendLastFrame(false);
            lastFrame = frame;
          }
        } else if (event.status === 'complete') {
          for (const frame of bstream.flush()) {
            sendLastFrame(false);
            lastFrame = frame;
          }
          sendLastFrame(true);
          if (!finished.done) finished.resolve();
        } else if (event.status === 'error') {
          finished.reject(
            new APIConnectionError({
              message: `SmallestAI TTS error: ${event.message ?? 'unknown error'}`,
            }),
          );
        }
      } catch (e) {
        this.#logger.warn({ error: e }, 'failed to process SmallestAI websocket message');
      }
    };

    const onClose = (code: number, reason: Buffer) => {
      if (!finished.done) {
        finished.reject(
          new APIStatusError({
            message: 'SmallestAI websocket closed unexpectedly',
            options: { statusCode: code || -1, body: { reason: reason.toString() } },
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
      ws.send(
        JSON.stringify({
          model: this.#opts.model,
          voice_id: this.#opts.voiceId,
          text,
          sample_rate: this.#opts.sampleRate,
          speed: this.#opts.speed,
          language: this.#opts.language,
        }),
      );

      await finished.await;
    } catch (e) {
      if (this.abortSignal.aborted) return;
      if (e instanceof APIStatusError || e instanceof APIConnectionError) throw e;
      throw new APIConnectionError({
        message: `SmallestAI websocket failed: ${(e as Error).message ?? 'unknown error'}`,
      });
    } finally {
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    }
  }
}

const rawDataToString = (raw: RawData): string => {
  if (Buffer.isBuffer(raw)) return raw.toString();
  if (Array.isArray(raw)) return Buffer.concat(raw).toString();
  return Buffer.from(raw as ArrayBuffer).toString();
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
