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
  createTimedString,
  shortuuid,
  tts,
} from '@livekit/agents';
import { type RawData, WebSocket } from 'ws';
import { type TTSEncoding, type TTSModels } from './models.js';

const NUM_CHANNELS = 1;
const SMALLEST_BASE_URL = 'https://api.smallest.ai/waves/v1';
const SMALLEST_WS_URL = 'wss://api.smallest.ai/waves/v1/tts/live';

/** @public */
export interface TTSOptions {
  apiKey?: string;
  model: TTSModels | string;
  voiceId?: string;
  sampleRate: number;
  speed: number;
  language: string;
  outputFormat: TTSEncoding | string;
  /** Request per-word timing events from WebSocket streaming synthesis. */
  wordTimestamps: boolean;
  baseUrl: string;
  wsUrl: string;
}

const defaultTTSOptions: TTSOptions = {
  apiKey: process.env.SMALLEST_API_KEY,
  model: 'lightning_v3.1_pro',
  sampleRate: 24000,
  speed: 1,
  language: 'en',
  outputFormat: 'pcm',
  wordTimestamps: false,
  baseUrl: SMALLEST_BASE_URL,
  wsUrl: SMALLEST_WS_URL,
};

/** @public */
export class TTS extends tts.TTS {
  #opts: TTSOptions;
  label = 'smallestai.TTS';

  constructor(opts: Partial<TTSOptions> = {}) {
    const merged = { ...defaultTTSOptions, ...opts };
    if (!merged.apiKey) {
      throw new Error('SmallestAI API key is required. Set SMALLEST_API_KEY or pass apiKey');
    }
    merged.voiceId ??= merged.model === 'lightning_v3.1_pro' ? 'meher' : 'sophia';

    super(merged.sampleRate, NUM_CHANNELS, {
      streaming: true,
      alignedTranscript: merged.wordTimestamps,
    });
    this.#opts = merged;
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'SmallestAI';
  }

  updateOptions(opts: Partial<Omit<TTSOptions, 'apiKey' | 'baseUrl' | 'wsUrl'>>) {
    this.#opts = { ...this.#opts, ...opts };
    this.updateCapabilities({ alignedTranscript: this.#opts.wordTimestamps });
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
}

/** @public */
export class ChunkedStream extends tts.ChunkedStream {
  #opts: TTSOptions;
  #connOptions: APIConnectOptions;
  label = 'smallestai.ChunkedStream';

  constructor(
    tts: TTS,
    text: string,
    opts: TTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, tts, connOptions, abortSignal);
    this.#opts = opts;
    this.#connOptions = connOptions ?? {
      maxRetry: 3,
      retryIntervalMs: 2000,
      timeoutMs: 10000,
    };
  }

  protected async run(): Promise<void> {
    const payload = JSON.stringify({ ...toSmallestOptions(this.#opts), text: this.inputText });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#connOptions.timeoutMs);
    this.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const res = await fetch(`${this.#opts.baseUrl}/tts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          'Content-Type': 'application/json',
          'X-Source': 'livekit',
          'X-LiveKit-Version': __PACKAGE_VERSION__,
        },
        body: payload,
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new APIStatusError({
          message: await res.text(),
          options: { statusCode: res.status },
        });
      }

      const requestId = shortuuid();
      const segmentId = shortuuid();
      const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
      for await (const chunk of res.body) {
        for (const frame of bstream.write(chunk)) {
          this.queue.put({ requestId, segmentId, frame, final: false });
        }
      }
      for (const frame of bstream.flush()) {
        this.queue.put({ requestId, segmentId, frame, final: true });
      }
    } catch (error) {
      if (error instanceof APIError) throw error;
      if (controller.signal.aborted) throw new APITimeoutError({});
      throw new APIConnectionError({ message: `SmallestAI TTS request failed: ${error}` });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** @public */
export class SynthesizeStream extends tts.SynthesizeStream {
  #opts: TTSOptions;
  label = 'smallestai.SynthesizeStream';

  constructor(tts: TTS, opts: TTSOptions, connOptions?: APIConnectOptions) {
    super(tts, connOptions);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    let textBuffer = '';
    for await (const data of this.input) {
      if (data === SynthesizeStream.FLUSH_SENTINEL) {
        const text = textBuffer.trim();
        textBuffer = '';
        if (text) await this.#runWS(text);
      } else {
        textBuffer += data;
      }
    }
  }

  async #runWS(text: string): Promise<void> {
    const requestId = shortuuid();
    const segmentId = shortuuid();
    const ws = await connectWS(this.#opts, this.connOptions, this.abortSignal);
    const bstream = new AudioByteStream(this.#opts.sampleRate, NUM_CHANNELS);
    let pendingTimedTranscripts: tts.SynthesizedAudio['timedTranscripts'] = [];

    try {
      ws.send(JSON.stringify({ ...toSmallestOptions(this.#opts), text }));

      for await (const raw of websocketMessages(ws)) {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        const status = event.status;

        if (status === 'chunk') {
          const audio = nestedString(event, 'data', 'audio');
          if (!audio) continue;
          for (const frame of bstream.write(Buffer.from(audio, 'base64'))) {
            this.queue.put({
              requestId,
              segmentId,
              frame,
              final: false,
              timedTranscripts: pendingTimedTranscripts.length
                ? pendingTimedTranscripts
                : undefined,
            });
            pendingTimedTranscripts = [];
          }
        } else if (status === 'word_timestamp') {
          const word = nestedString(event, 'data', 'word');
          const startTime = nestedNumber(event, 'data', 'start');
          const endTime = nestedNumber(event, 'data', 'end');
          if (word && startTime !== undefined && endTime !== undefined) {
            pendingTimedTranscripts.push(createTimedString({ text: word, startTime, endTime }));
          }
        } else if (status === 'complete') {
          for (const frame of bstream.flush()) {
            this.queue.put({
              requestId,
              segmentId,
              frame,
              final: true,
              timedTranscripts: pendingTimedTranscripts.length
                ? pendingTimedTranscripts
                : undefined,
            });
            pendingTimedTranscripts = [];
          }
          this.queue.put(SynthesizeStream.END_OF_STREAM);
          return;
        } else if (status === 'error') {
          throw new APIConnectionError({
            message: `SmallestAI TTS error: ${String(event.message ?? 'unknown error')}`,
          });
        }
      }
    } finally {
      ws.close();
    }
  }
}

function toSmallestOptions(opts: TTSOptions): Record<string, unknown> {
  return {
    model: opts.model,
    voice_id: opts.voiceId,
    sample_rate: opts.sampleRate,
    speed: opts.speed,
    language: opts.language,
    output_format: opts.outputFormat,
    ...(opts.wordTimestamps ? { word_timestamps: true } : {}),
  };
}

async function connectWS(
  opts: TTSOptions,
  connOptions: APIConnectOptions,
  abortSignal: AbortSignal,
): Promise<WebSocket> {
  const ws = new WebSocket(opts.wsUrl, {
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'X-Source': 'livekit',
      'X-LiveKit-Version': __PACKAGE_VERSION__,
    },
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    ws.terminate();
  }, connOptions.timeoutMs);
  abortSignal.addEventListener('abort', () => ws.terminate(), { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (error) => reject(error));
      ws.once('close', (code) => reject(new Error(`WebSocket returned ${code}`)));
    });
  } catch (error) {
    if (timedOut) throw new APITimeoutError({ message: 'SmallestAI TTS connection timed out' });
    throw new APIConnectionError({ message: `failed to connect to SmallestAI TTS: ${error}` });
  } finally {
    clearTimeout(timeout);
  }

  return ws;
}

function websocketMessages(ws: WebSocket): AsyncIterable<RawData> {
  return new AsyncQueue<RawData>((queue) => {
    ws.on('message', (data) => queue.push(data));
    ws.on('error', (error) => queue.throw(error));
    ws.on('close', () => queue.close());
  });
}

function nestedString(obj: Record<string, unknown>, parent: string, key: string): string {
  const nested = obj[parent];
  if (!nested || typeof nested !== 'object') return '';
  const value = (nested as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function nestedNumber(
  obj: Record<string, unknown>,
  parent: string,
  key: string,
): number | undefined {
  const nested = obj[parent];
  if (!nested || typeof nested !== 'object') return undefined;
  const value = (nested as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #resolve: (() => void) | undefined;
  #closed = false;
  #error: unknown;

  constructor(setup?: (queue: AsyncQueue<T>) => void) {
    setup?.(this);
  }

  push(item: T) {
    this.#items.push(item);
    this.#resolve?.();
  }

  throw(error: unknown) {
    this.#error = error;
    this.close();
  }

  close() {
    this.#closed = true;
    this.#resolve?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.#closed || this.#items.length > 0) {
      if (this.#items.length === 0) {
        await new Promise<void>((resolve) => {
          this.#resolve = resolve;
        });
      }
      if (this.#error) throw this.#error;
      const item = this.#items.shift();
      if (item !== undefined) yield item;
    }
  }
}
