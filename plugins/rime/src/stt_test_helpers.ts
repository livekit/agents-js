// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue, VAD, type VADEvent, VADEventType, VADStream } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import * as sdk from '@rimelabs/sdk';
import { vi } from 'vitest';
import type { RequestOptions, SDK, SDKStream, TranscriptUpdate } from './stt_sdk.js';
import { abortable } from './stt_sdk.js';

export function frame(rate = 16000, channels = 1, samples = rate / 10): AudioFrame {
  const data = new Int16Array(samples * channels);
  for (let i = 0; i < data.length; i++) data[i] = 20000 + (i % channels) * 1000;
  return new AudioFrame(data, rate, channels, samples);
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export class Detector extends VAD {
  label = 'test.VAD';
  streams: DetectorStream[] = [];
  override close = vi.fn(async () => {});
  constructor() {
    super({ updateInterval: 32 });
  }
  stream() {
    const stream = new DetectorStream(this);
    this.streams.push(stream);
    return stream;
  }
}
export class DetectorStream extends VADStream {
  frames: AudioFrame[] = [];
  ended = false;
  readonly stopped: Promise<void>;
  constructor(owner: VAD) {
    super(owner);
    this.stopped = (async () => {
      try {
        while (true) {
          const result = await this.inputReader.read();
          if (result.done) break;
          if (typeof result.value !== 'symbol') this.frames.push(result.value);
        }
      } finally {
        this.ended = true;
        this.close();
      }
    })();
  }
  get isClosed() {
    return this.closed;
  }
  async send(type: VADEventType, frames: AudioFrame[] = [frame()], timing: Partial<VADEvent> = {}) {
    await this.outputWriter.write({
      type,
      frames,
      timestamp: Date.now(),
      speechDuration: 0,
      silenceDuration: 500,
      inferenceDuration: 20,
      samplesIndex: 0,
      probability: 1,
      speaking: type !== VADEventType.END_OF_SPEECH,
      rawAccumulatedSilence: 0,
      rawAccumulatedSpeech: 0,
      ...timing,
    });
  }
}
export class ProviderStream implements SDKStream {
  requestId = 'test-request';
  readonly audio: Uint8Array[] = [];
  readonly controller = new AbortController();
  closed = false;
  readonly iterator: AsyncGenerator<TranscriptUpdate>;
  constructor(
    readonly source: AsyncIterable<Uint8Array>,
    readonly options: RequestOptions,
    generate: (self: ProviderStream) => AsyncGenerator<TranscriptUpdate>,
  ) {
    options.signal.addEventListener('abort', this.abort, { once: true });
    this.iterator = generate(this);
  }
  private abort = () => this.controller.abort(new sdk.RimeCancelledError('private cancellation'));
  async *chunks() {
    const iterator = this.source[Symbol.asyncIterator]();
    while (true) {
      const result = await abortable(iterator.next(), this.controller.signal);
      if (result.done) break;
      this.audio.push(result.value);
      yield result.value;
    }
  }
  async wait(promise: Promise<unknown>) {
    await abortable(promise, this.controller.signal);
  }
  async next() {
    return abortable(this.iterator.next(), this.controller.signal);
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  async return(): Promise<IteratorResult<TranscriptUpdate>> {
    await this.cancel();
    return { done: true, value: undefined };
  }
  async cancel() {
    if (this.closed) return;
    this.closed = true;
    this.options.signal.removeEventListener('abort', this.abort);
    this.abort();
    await this.iterator.return(undefined).catch(() => {});
  }
}
export async function* normal(self: ProviderStream): AsyncGenerator<TranscriptUpdate> {
  let text = '';
  for await (const _chunk of self.chunks()) {
    const delta = text ? ' \ncream' : 'Ice';
    text += delta;
    yield self.options.outputContract === 'append_fragments'
      ? { kind: 'delta', text: delta }
      : { kind: 'partial', text };
  }
  yield { kind: 'final', text, language: 'en' };
}
export function provider(generate = normal) {
  const streams: ProviderStream[] = [];
  const transcribe = vi.fn(async (_audio: Uint8Array, _options: RequestOptions) => ({
    text: 'Hello.',
    language: 'en',
    requestId: 'unary-id' as string | null,
  }));
  const client = {
    stt: {
      transcribe,
      stream: vi.fn((source: AsyncIterable<Uint8Array>, options: RequestOptions) => {
        const stream = new ProviderStream(source, options, generate);
        streams.push(stream);
        return stream;
      }),
    },
    close: vi.fn(async () => {}),
  };
  const module = {
    ...sdk,
    Rime: class {
      constructor() {
        return client;
      }
    },
  } as unknown as SDK;
  return { streams, client, module };
}
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}
export { sdk, AsyncIterableQueue };
