// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { getEventListeners } from 'node:events';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { APIConnectionError } from '../_exceptions.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import type { APIConnectOptions } from '../types.js';
import { Future } from '../utils.js';
import { FallbackAdapter } from './fallback_adapter.js';
import { ChunkedStream, SynthesizeStream, TTS, type TTSError } from './tts.js';

type Mode = 'audio' | 'silent' | 'error' | 'blocked' | 'blocked-after-audio';

function audio() {
  return {
    requestId: 'test',
    segmentId: 'test',
    final: false,
    frame: new AudioFrame(new Int16Array(240), 24000, 1, 240),
  };
}

class TestStream extends SynthesizeStream {
  label = 'test.stream';
  constructor(
    private provider: TestTTS,
    options?: APIConnectOptions,
  ) {
    super(provider, options);
    this.abortSignal.addEventListener('abort', () => provider.release.resolve(), { once: true });
  }
  protected async run() {
    if (this.provider.mode === 'error')
      throw new APIConnectionError({ message: 'provider failed' });
    for await (const text of this.input) {
      if (typeof text !== 'string') continue;
      this.provider.received.resolve();
      if (this.provider.mode === 'silent') return;
      if (this.provider.mode !== 'blocked') this.queue.put(audio());
      if (this.provider.mode.startsWith('blocked')) {
        await this.provider.release.await;
        return;
      }
    }
  }
}

class TestChunk extends ChunkedStream {
  label = 'test.chunk';
  constructor(
    private provider: TestTTS,
    text: string,
    options?: APIConnectOptions,
  ) {
    super(text, provider, options);
    this.abortSignal.addEventListener('abort', () => provider.release.resolve(), { once: true });
  }
  protected async run() {
    if (this.provider.mode === 'error')
      throw new APIConnectionError({ message: 'provider failed' });
    this.provider.received.resolve();
    if (this.provider.mode === 'audio') this.queue.put(audio());
    if (this.provider.mode.startsWith('blocked')) await this.provider.release.await;
  }
}

class TestTTS extends TTS {
  received = new Future();
  release = new Future();
  streams: TestStream[] = [];
  chunks: TestChunk[] = [];
  constructor(
    public label: string,
    public mode: Mode,
  ) {
    super(24000, 1, { streaming: true });
  }
  stream(options?: { connOptions?: APIConnectOptions }) {
    const stream = new TestStream(this, options?.connOptions);
    this.streams.push(stream);
    return stream;
  }
  synthesize(text: string, options?: APIConnectOptions) {
    const stream = new TestChunk(this, text, options);
    this.chunks.push(stream);
    return stream;
  }
}

// close() can end iteration before the synthesis task emits its error.
function waitForRun(stream: SynthesizeStream | ChunkedStream): () => Promise<void> {
  const target = stream as unknown as { run(): Promise<void> };
  const original = target.run.bind(target);
  const done = new Future();
  vi.spyOn(target, 'run').mockImplementation(async () => {
    try {
      await original();
    } finally {
      done.resolve();
    }
  });
  return async () => {
    await done.await;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}

function setup(mode: Mode) {
  const primary = new TestTTS('primary', mode);
  const secondary = new TestTTS('secondary', 'audio');
  const adapter = new FallbackAdapter({
    ttsInstances: [primary, secondary],
    maxRetryPerTTS: 0,
    recoveryDelayMs: 60_000,
  });
  const errors: TTSError[] = [];
  adapter.on('error', (error) => errors.push(error));
  return { primary, secondary, adapter, errors };
}

describe('TTS fallback lifecycle', () => {
  it('does not start providers when closed before receiving input', async () => {
    const { primary, secondary, adapter, errors } = setup('audio');
    const stream = adapter.stream();
    const settled = waitForRun(stream);
    try {
      stream.close();
      await settled();
      expect(primary.streams).toHaveLength(0);
      expect(secondary.streams).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it.each(['blocked', 'blocked-after-audio'] as const)(
    'cancels an active %s stream without changing provider health',
    async (mode) => {
      const { primary, secondary, adapter, errors } = setup(mode);
      const stream = adapter.stream();
      const settled = waitForRun(stream);
      try {
        stream.pushText('Hello.');
        await primary.received.await;
        if (mode === 'blocked-after-audio') await stream.next();
        stream.close();
        await vi.waitFor(() => expect(primary.streams[0]!.abortSignal.aborted).toBe(true));
        await settled();
        expect(errors).toEqual([]);
        expect(adapter.status.map((status) => status.available)).toEqual([true, true]);
        expect(primary.chunks).toHaveLength(0);
        expect(secondary.streams).toHaveLength(0);
      } finally {
        stream.close();
        primary.release.resolve();
        await settled();
        await adapter.close();
      }
    },
  );

  it('attributes cancelled partial audio to the provider that served it', async () => {
    const { adapter, secondary, errors } = setup('error');
    secondary.mode = 'blocked-after-audio';
    vi.spyOn(secondary, 'model', 'get').mockReturnValue('secondary-model');
    vi.spyOn(secondary, 'provider', 'get').mockReturnValue('cartesia');
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    const previous = tracer.getProvider();
    setTracerProvider(provider);
    try {
      await tracer.startActiveSpan(
        async () => {
          const stream = adapter.stream();
          const settled = waitForRun(stream);
          try {
            stream.pushText('Hello.');
            const frame = await stream.next();
            expect(frame.done).toBe(false);
            expect(frame.value).not.toBe(SynthesizeStream.END_OF_STREAM);
            // Recovery can make the primary preferred before this speech is cancelled.
            adapter.status[0]!.available = true;
          } finally {
            stream.close();
            await settled();
          }
        },
        { name: 'caller' },
      );
      const caller = exporter.getFinishedSpans().find((span) => span.name === 'caller');
      expect(caller?.attributes[traceTypes.ATTR_GEN_AI_RESPONSE_MODEL]).toBe('secondary-model');
      expect(caller?.attributes[traceTypes.ATTR_GEN_AI_PROVIDER_NAME]).toBe('cartesia');
      expect(errors).toEqual([]);
    } finally {
      await adapter.close();
      setTracerProvider(previous);
      await provider.shutdown();
      trace.disable();
      otelContext.disable();
    }
  });

  it.each(['close', 'abort'] as const)('cancels chunked synthesis through %s', async (method) => {
    const { primary, secondary, adapter, errors } = setup('blocked');
    const controller = new AbortController();
    const stream = adapter.synthesize('Hello.', undefined, controller.signal);
    const settled = waitForRun(stream);
    try {
      await primary.received.await;
      if (method === 'close') stream.close();
      else controller.abort();
      await vi.waitFor(() => expect(primary.chunks[0]!.abortSignal.aborted).toBe(true));
      await settled();
      expect(errors).toEqual([]);
      expect(adapter.status.map((status) => status.available)).toEqual([true, true]);
      expect(primary.chunks).toHaveLength(1);
      expect(secondary.chunks).toHaveLength(0);
    } finally {
      stream.close();
      primary.release.resolve();
      await settled();
      await adapter.close();
    }
  });

  it.each([{ tokens: [] }, { tokens: [''] }])(
    'keeps providers healthy for empty input $tokens',
    async ({ tokens }) => {
      const { primary, secondary, adapter, errors } = setup('silent');
      const stream = adapter.stream();
      const settled = waitForRun(stream);
      try {
        stream.updateInputStream(
          new ReadableStream<string>({
            start(controller) {
              for (const token of tokens) controller.enqueue(token);
              controller.close();
            },
          }),
        );
        await settled();
        expect(errors).toEqual([]);
        expect(primary.chunks).toHaveLength(0);
        expect(secondary.streams).toHaveLength(0);
        expect(adapter.status.map((status) => status.available)).toEqual([true, true]);
      } finally {
        stream.close();
        await adapter.close();
      }
    },
  );

  it.each(['empty', 'already aborted'] as const)(
    'skips providers for %s chunked input',
    async (mode) => {
      const { primary, secondary, adapter, errors } = setup('audio');
      const controller = new AbortController();
      if (mode === 'already aborted') controller.abort();
      const stream = adapter.synthesize(
        mode === 'empty' ? '' : 'Hello.',
        undefined,
        controller.signal,
      );
      try {
        const frames = [];
        for await (const frame of stream) frames.push(frame);
        expect(frames).toEqual([]);
        expect(errors).toEqual([]);
        expect(primary.chunks).toHaveLength(0);
        expect(secondary.chunks).toHaveLength(0);
      } finally {
        stream.close();
        await adapter.close();
      }
    },
  );

  it('falls back on real silence while the text input remains open', async () => {
    const { adapter, primary, secondary, errors } = setup('silent');
    const stream = adapter.stream();
    const settled = waitForRun(stream);
    const abortListeners = getEventListeners(stream.abortSignal, 'abort').length;
    try {
      stream.pushText('Hello.');
      const frame = await stream.next();
      expect(frame.done).toBe(false);
      expect(frame.value).not.toBe(SynthesizeStream.END_OF_STREAM);
      expect(primary.streams).toHaveLength(1);
      expect(secondary.streams).toHaveLength(1);
      expect(adapter.status.map((status) => status.available)).toEqual([false, true]);
      expect(errors).toEqual([]);
      stream.endInput();
      await settled();
      expect(getEventListeners(stream.abortSignal, 'abort')).toHaveLength(abortListeners);
    } finally {
      stream.close();
      await settled();
      await adapter.close();
    }
  });

  it('does not hide a provider error when input is empty', async () => {
    const { adapter, errors } = setup('error');
    const stream = adapter.stream();
    const settled = waitForRun(stream);
    try {
      stream.endInput();
      await settled();
      expect(adapter.status.map((status) => status.available)).toEqual([false, true]);
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await adapter.close();
    }
  });

  it('suppresses the aggregate error when cancelled after providers fail but before input ends', async () => {
    const { adapter, secondary, errors } = setup('error');
    secondary.mode = 'error';
    const stream = adapter.stream();
    const settled = waitForRun(stream);
    try {
      stream.pushText('Hello.');
      await vi.waitFor(() =>
        expect(adapter.status.every((status) => !status.available)).toBe(true),
      );
      stream.close();
      await settled();
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await settled();
      await adapter.close();
    }
  });
});
