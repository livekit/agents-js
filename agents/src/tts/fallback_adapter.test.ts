// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type AudioResampler } from '@livekit/rtc-node';
import { context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { APIConnectionError, APIError, APIStatusError } from '../_exceptions.js';
import { TTS as InferenceTTS } from '../inference/tts.js';
import { initializeLogger, log } from '../log.js';
import type { TTSMetrics } from '../metrics/base.js';
import { ModelUsageCollector } from '../metrics/model_usage.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import { basic } from '../tokenize/index.js';
import type { APIConnectOptions } from '../types.js';
import { USERDATA_TTS_STARTED_TIME } from '../types.js';
import { Future, delay } from '../utils.js';
import { type AvailabilityChangedEvent, FallbackAdapter } from './fallback_adapter.js';
import { StreamAdapter } from './stream_adapter.js';
import {
  ChunkedStream,
  type FallbackActivatedEvent,
  SynthesizeStream,
  TTS,
  type TTSError,
} from './tts.js';

const SAMPLE_RATE = 24000;
const FALLBACK_ACTIVATED_EVENT: FallbackActivatedEvent = {
  sessionId: 'session-1',
  fallbackType: 'fallback',
  provider: 'deepgram',
  model: 'deepgram/aura-2',
  voice: 'asteria',
  cause: 'provider_error',
};

class MockSynthesizeStream extends SynthesizeStream {
  label = 'mock.SynthesizeStream';

  constructor(
    private mockTts: MockTTS,
    private shouldFail: boolean,
    private blocked: boolean,
    connOptions?: APIConnectOptions,
  ) {
    super(mockTts, connOptions);
  }

  // Simulate sending text to the provider, like a real plugin does right
  // before ws.send(): optionally delay (sentence buffering / connection
  // setup), then mark the started time and record it for assertions.
  private async sendToProvider(): Promise<void> {
    if (this.mockTts.sendDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.mockTts.sendDelayMs));
    }
    this.markStarted();
    this.mockTts.lastMarkedTime = this.startedTime?.time;
    this.mockTts.firstMarkedTime ??= this.mockTts.lastMarkedTime;
  }

  protected async run(): Promise<void> {
    this.mockTts.started.resolve();
    if (this.blocked) {
      if (this.abortSignal.aborted) return;
      await new Promise<void>((resolve) => {
        this.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      return;
    }
    if (this.shouldFail) {
      if (this.mockTts.failAfterInput) {
        // Simulate a provider that receives text but dies before emitting
        // any audio: the started time it recorded must still anchor the
        // fallback adapter's TTFB.
        for await (const data of this.input) {
          if (this.abortController.signal.aborted) break;
          if (data === SynthesizeStream.FLUSH_SENTINEL) continue;
          await this.sendToProvider();
          break;
        }
        throw this.mockTts.failWith ?? new APIError('mock TTS failed after receiving input');
      }
      if (this.mockTts.failAfterAudio) {
        for await (const data of this.input) {
          if (this.abortController.signal.aborted) break;
          if (data === SynthesizeStream.FLUSH_SENTINEL) continue;
          this.queue.put({
            requestId: 'mock-req',
            segmentId: 'mock-seg',
            frame: new AudioFrame(new Int16Array(160), this.mockTts.sampleRate, 1, 160),
            final: false,
          });
          break;
        }
        throw this.mockTts.failWith ?? new APIError('mock TTS failed after emitting audio');
      }
      // Throw immediately, before any pushText has been called.
      // This is the scenario that previously deadlocked the FallbackAdapter:
      // the inner stream's mainTask finishes before forwardBufferToTTS gets
      // a chance to call pushText, so #monitorMetricsTask never starts and
      // this.output is never closed.
      throw this.mockTts.failWith ?? new APIError('mock TTS failed immediately');
    }

    // Happy path: read text from this.input and emit a single audio frame per token.
    for await (const data of this.input) {
      if (this.abortController.signal.aborted) break;
      if (data === SynthesizeStream.FLUSH_SENTINEL) continue;
      await this.sendToProvider();
      this.queue.put({
        requestId: 'mock-req',
        segmentId: 'mock-seg',
        frame: new AudioFrame(new Int16Array(160), this.mockTts.sampleRate, 1, 160),
        final: false,
      });
    }
  }
}

class MockChunkedStream extends ChunkedStream {
  label = 'mock.ChunkedStream';
  constructor(
    private mockTts: MockTTS,
    text: string,
    private shouldFail: boolean,
    private blocked: boolean,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, mockTts, connOptions, abortSignal);
  }
  protected async run(): Promise<void> {
    this.mockTts.started.resolve();
    if (this.blocked) {
      if (this.abortSignal.aborted) return;
      await new Promise<void>((resolve) => {
        this.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      return;
    }
    if (this.shouldFail && !this.mockTts.failAfterAudio) {
      throw this.mockTts.failWith ?? new APIError('mock TTS failed immediately');
    }
    this.queue.put({
      requestId: 'mock-req',
      segmentId: 'mock-seg',
      frame: new AudioFrame(new Int16Array(160), this.mockTts.sampleRate, 1, 160),
      final: true,
    });
    if (this.shouldFail) {
      throw this.mockTts.failWith ?? new APIError('mock TTS failed after emitting audio');
    }
  }
}

/** A chunked stream that runs `script` and never produces audio. */
class ScriptedChunkedStream extends ChunkedStream {
  label = 'scripted.ChunkedStream';
  constructor(
    tts: TTS,
    text: string,
    connOptions: APIConnectOptions | undefined,
    private script: () => Promise<void>,
  ) {
    super(text, tts, connOptions);
  }
  protected async run(): Promise<void> {
    await this.script();
  }
}

class MockTTS extends TTS {
  label: string;
  shouldFail = false;
  blocked = false;
  started = new Future();
  /** When failing, first consume a token (and mark started) before throwing. */
  failAfterInput = false;
  /** When failing, first emit one frame of audio before throwing. */
  failAfterAudio = false;
  /** The error raised when failing; defaults to a generic retryable APIError. */
  failWith?: APIError;
  /** Simulated latency between receiving text and sending it to the provider. */
  sendDelayMs = 0;
  /** The started time the stream recorded when it "sent" text to the provider. */
  lastMarkedTime?: number;
  /** The first such started time: later streams (recovery probes) overwrite `lastMarkedTime`. */
  firstMarkedTime?: number;

  closeCount = 0;

  constructor(label: string, sampleRate: number = SAMPLE_RATE, streaming = true) {
    super(sampleRate, 1, { streaming });
    this.label = label;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new MockChunkedStream(
      this,
      text,
      this.shouldFail,
      this.blocked,
      connOptions,
      abortSignal,
    );
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new MockSynthesizeStream(this, this.shouldFail, this.blocked, options?.connOptions);
  }

  override async close(): Promise<void> {
    this.closeCount++;
  }
}

function textInput(text = 'hello test'): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

/** Emits a notice per request, after the call returns, as an inference TTS does on gateway fallback. */
class NotifyingTTS extends MockTTS {
  private notify(voice: string): void {
    queueMicrotask(() => this.emit('fallback_activated', { ...FALLBACK_ACTIVATED_EVENT, voice }));
  }

  override synthesize(text: string, connOptions?: APIConnectOptions): ChunkedStream {
    this.notify(text);
    return super.synthesize(text, connOptions);
  }

  override stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    this.notify('served');
    return super.stream(options);
  }
}

/** Like `inference.TTS`: streams, but has no `synthesize()`. */
class StreamOnlyTTS extends MockTTS {
  override synthesize(): ChunkedStream {
    throw new Error('ChunkedStream is not implemented');
  }
}

/** Plays `plan` one step per `stream()` call (the last step repeats): fail, block until closed, or serve. */
class SequencedTTS extends MockTTS {
  streamCalls = 0;

  constructor(
    label: string,
    private plan: ('fail' | 'block' | 'ok')[],
  ) {
    super(label);
  }

  override stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const step = this.plan[Math.min(this.streamCalls, this.plan.length - 1)]!;
    this.streamCalls++;
    this.shouldFail = step === 'fail';
    this.blocked = step === 'block';
    return super.stream(options);
  }
}

/** Streams one frame of audio, then hangs until closed. */
class FrameThenHangStream extends SynthesizeStream {
  label = 'hanging.SynthesizeStream';

  constructor(
    private hangingTts: FrameThenHangTTS,
    connOptions?: APIConnectOptions,
  ) {
    super(hangingTts, connOptions);
  }

  protected async run(): Promise<void> {
    for await (const data of this.input) {
      if (data === SynthesizeStream.FLUSH_SENTINEL) continue;
      this.queue.put({
        requestId: 'hang-req',
        segmentId: 'hang-seg',
        frame: new AudioFrame(new Int16Array(160), this.hangingTts.sampleRate, 1, 160),
        final: false,
      });
      this.hangingTts.frames++;
      break;
    }
    if (this.abortSignal.aborted) return;
    await new Promise<void>((resolve) => {
      this.abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
}

/** A provider whose streams send one frame and then never finish, like a socket gone quiet. */
class FrameThenHangTTS extends MockTTS {
  frames = 0;

  override stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new FrameThenHangStream(this, options?.connOptions);
  }
}

function streamText(tts: TTS, text: string): SynthesizeStream {
  const stream = tts.stream();
  stream.updateInputStream(
    new ReadableStream<string>({
      start(controller) {
        controller.enqueue(text);
        controller.close();
      },
    }),
  );
  return stream;
}

type Mode = 'chunked' | 'streaming';

/** One request on the given path, to the end. Counts the frames the caller got. */
async function request(
  adapter: TTS,
  mode: Mode,
  text = 'hello world.',
): Promise<{ frames: number; ended: boolean }> {
  const stream = mode === 'chunked' ? adapter.synthesize(text) : streamText(adapter, text);
  let frames = 0;
  let ended = false;
  try {
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) {
        ended = true;
        break;
      }
      frames++;
    }
  } finally {
    stream.close();
  }
  return { frames, ended };
}

describe('TTS FallbackAdapter', () => {
  const unhandledRejections: unknown[] = [];

  beforeAll(() => {
    initializeLogger({ pretty: false });
    process.on('unhandledRejection', (reason) => unhandledRejections.push(reason));
  });

  beforeEach(() => {
    unhandledRejections.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes temporary stream adapters after each request', async () => {
    const nonStreaming = new MockTTS('non-streaming', SAMPLE_RATE, false);
    const adapter = new FallbackAdapter({ ttsInstances: [nonStreaming] });
    const baseline = nonStreaming.listenerCount('metrics_collected');

    try {
      for (let i = 0; i < 3; i++) {
        expect((await request(adapter, 'streaming')).frames).toBeGreaterThan(0);
        expect(nonStreaming.listenerCount('metrics_collected')).toBe(baseline);
      }
      expect(nonStreaming.closeCount).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  it('closes a temporary stream adapter after failure and fallback', async () => {
    const nonStreaming = new MockTTS('non-streaming', SAMPLE_RATE, false);
    nonStreaming.shouldFail = true;
    const adapter = new FallbackAdapter({
      ttsInstances: [nonStreaming, new MockTTS('fallback')],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });
    const baseline = nonStreaming.listenerCount('metrics_collected');

    try {
      expect((await request(adapter, 'streaming')).frames).toBeGreaterThan(0);
      expect(nonStreaming.listenerCount('metrics_collected')).toBe(baseline);
      expect(nonStreaming.closeCount).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  describe.each([true, false])('cancellation with streaming=%s', (streaming) => {
    it.each(['before synthesis', 'during synthesis'] as const)(
      'preserves provider health when cancelled %s',
      async (when) => {
        const primary = new MockTTS('primary', SAMPLE_RATE, streaming);
        primary.blocked = true;
        const secondary = new MockTTS('secondary', SAMPLE_RATE, streaming);
        const adapter = new FallbackAdapter({
          ttsInstances: [primary, secondary],
          maxRetryPerTTS: 0,
        });
        const errors: TTSError[] = [];
        adapter.on('error', (error) => errors.push(error));
        const primaryStream = vi.spyOn(primary, 'stream');
        const primarySynthesize = vi.spyOn(primary, 'synthesize');
        const secondaryStream = vi.spyOn(secondary, 'stream');
        const secondarySynthesize = vi.spyOn(secondary, 'synthesize');
        const metricsBaseline = primary.listenerCount('metrics_collected');
        const errorBaseline = primary.listenerCount('error');
        const stream = adapter.stream();
        stream.updateInputStream(textInput());

        try {
          if (when === 'during synthesis') {
            await primary.started.await;
          }
          stream.close();
          await delay(50);

          expect(adapter.status.map((status) => status.available)).toEqual([true, true]);
          expect(adapter.status.every((status) => status.recoveringTask === null)).toBe(true);
          expect(primaryStream).toHaveBeenCalledTimes(
            when === 'during synthesis' && streaming ? 1 : 0,
          );
          expect(primarySynthesize).toHaveBeenCalledTimes(
            when === 'during synthesis' && !streaming ? 1 : 0,
          );
          expect(secondaryStream).not.toHaveBeenCalled();
          expect(secondarySynthesize).not.toHaveBeenCalled();
          expect(errors).toEqual([]);
          expect(stream.error).toBeUndefined();
          expect(primary.listenerCount('metrics_collected')).toBe(metricsBaseline);
          expect(primary.listenerCount('error')).toBe(errorBaseline);
          expect(primary.closeCount).toBe(0);
          expect(unhandledRejections).toEqual([]);
        } finally {
          stream.close();
          await adapter.close();
        }
      },
    );
  });

  it('does not report exhaustion when cancelled while input is still open', async () => {
    const primary = new MockTTS('primary');
    primary.shouldFail = true;
    const adapter = new FallbackAdapter({
      ttsInstances: [primary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });
    const errors: TTSError[] = [];
    adapter.on('error', (error) => errors.push(error));
    const stream = adapter.stream();
    stream.updateInputStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue('hello test');
        },
      }),
    );

    try {
      await vi.waitFor(() => expect(adapter.status[0]!.available).toBe(false));
      stream.close();
      await delay(50);
      expect(errors).toEqual([]);
      expect(stream.error).toBeUndefined();
    } finally {
      stream.close();
      await adapter.close();
    }
  });

  it.each(['chunked', 'streaming', 'non-streaming provider', 'stream adapter'] as const)(
    'counts provider usage once for %s synthesis',
    async (mode) => {
      const exporter = new InMemorySpanExporter();
      const tracerProvider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      tracerProvider.register();
      const previous = tracer.getProvider();
      setTracerProvider(tracerProvider);
      const primary = new MockTTS('primary', SAMPLE_RATE, mode === 'streaming');
      vi.spyOn(primary, 'model', 'get').mockReturnValue('sonic-3.6');
      vi.spyOn(primary, 'provider', 'get').mockReturnValue('cartesia');
      const adapter =
        mode === 'stream adapter'
          ? new StreamAdapter(primary)
          : new FallbackAdapter({ ttsInstances: [primary] });
      const metrics: TTSMetrics[] = [];
      const usage = new ModelUsageCollector();
      adapter.on('metrics_collected', (metric) => {
        metrics.push(metric);
        usage.collect(metric);
      });

      const text = 'hello world';
      const stream = mode === 'chunked' ? adapter.synthesize(text) : adapter.stream();
      try {
        if (stream instanceof SynthesizeStream) {
          stream.updateInputStream(
            new ReadableStream<string>({
              start(controller) {
                controller.enqueue(text);
                controller.close();
              },
            }),
          );
        }
        let frames = 0;
        for await (const event of stream) {
          if (event !== SynthesizeStream.END_OF_STREAM) frames++;
        }

        expect(frames).toBe(1);
        expect(metrics.map((metric) => metric.label)).toEqual([primary.label]);
        expect(usage.flatten()).toEqual([
          {
            type: 'tts_usage',
            provider: 'cartesia',
            model: 'sonic-3.6',
            inputTokens: 0,
            outputTokens: 0,
            charactersCount: text.length,
            audioDurationMs: Math.round((160 / SAMPLE_RATE) * 1000),
          },
        ]);
        const tracedMetrics = exporter
          .getFinishedSpans()
          .filter((span) => traceTypes.ATTR_TTS_METRICS in span.attributes)
          .map((span) => JSON.parse(span.attributes[traceTypes.ATTR_TTS_METRICS] as string));
        expect(tracedMetrics).toEqual(metrics);
      } finally {
        stream.close();
        await adapter.close();
        setTracerProvider(previous);
        await tracerProvider.shutdown();
        trace.disable();
        otelContext.disable();
      }
    },
  );

  it.each(['chunked', 'streaming', 'non-streaming provider'] as const)(
    'forwards fallback activation events only while serving a %s request',
    async (mode) => {
      const source = new NotifyingTTS('source', SAMPLE_RATE, mode === 'streaming');
      const adapter = new FallbackAdapter({ ttsInstances: [source] });
      const voices: string[] = [];
      adapter.on('fallback_activated', (event) => voices.push(event.voice));

      await request(adapter, mode === 'chunked' ? 'chunked' : 'streaming', 'served');
      // a recovery probe runs with no user attempt in flight
      source.emit('fallback_activated', { ...FALLBACK_ACTIVATED_EVENT, voice: 'idle' });
      await adapter.close();
      source.emit('fallback_activated', { ...FALLBACK_ACTIVATED_EVENT, voice: 'after-close' });

      expect(voices).toEqual(['served']);
    },
  );

  it('does not forward fallback activation events from recovery probes', async () => {
    const primary = new NotifyingTTS('primary');
    primary.shouldFail = true;
    const probe = vi.spyOn(primary, 'stream');
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, new MockTTS('secondary')],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });
    const voices: string[] = [];
    adapter.on('fallback_activated', (event) => voices.push(event.voice));

    await request(adapter, 'chunked', 'served');
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    await delay(10);

    // the probe's notice (the stream's own 'served') is not forwarded: only the request's is
    expect(voices).toEqual(['served']);
    await adapter.close();
  });

  it('forwards fallback activation events through StreamAdapter', async () => {
    const source = new MockTTS('source');
    const adapter = new StreamAdapter(source, new basic.SentenceTokenizer());
    const events: FallbackActivatedEvent[] = [];
    adapter.on('fallback_activated', (event) => events.push(event));

    source.emit('fallback_activated', FALLBACK_ACTIVATED_EVENT);

    expect(events).toEqual([FALLBACK_ACTIVATED_EVENT]);
    await adapter.close();
  });

  it('should fall back to the next TTS when the primary stream fails before any pushText', async () => {
    const primary = new MockTTS('primary');
    primary.shouldFail = true;
    const secondary = new MockTTS('secondary');
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const stream = adapter.stream();
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello world');
          controller.close();
        },
      }),
    );

    // With the deadlock bug, this loop hangs forever because the inner
    // primary stream's this.output is never closed. Use a hard timeout to
    // turn the deadlock into a test failure.
    const iterate = (async () => {
      let frameCount = 0;
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) break;
        frameCount++;
      }
      return frameCount;
    })();

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('fallback adapter deadlocked')), 3000),
    );

    const frameCount = await Promise.race([iterate, timeout]);

    expect(frameCount).toBeGreaterThan(0);
    expect(adapter.status[0]!.available).toBe(false);
    expect(adapter.status[1]!.available).toBe(true);

    stream.close();
    await adapter.close();
  });

  it('should fall back when the primary has a mismatched sample rate and emits no audio', async () => {
    // Primary runs at 22050Hz, adapter aggregates at 24000Hz → a resampler is
    // created for the primary. The primary throws with no frames ever pushed,
    // so `resampler.push()` is never called. Regression test for a bug where
    // `resampler.flush()` on an unused resampler returned a phantom frame,
    // flipping `audioPushed` to true and making the adapter incorrectly
    // treat a silent failure as a success.
    const primary = new MockTTS('primary', 22050);
    primary.shouldFail = true;
    const secondary = new MockTTS('secondary', 24000);
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const stream = adapter.stream();
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello world');
          controller.close();
        },
      }),
    );

    const iterate = (async () => {
      let frameCount = 0;
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) break;
        frameCount++;
      }
      return frameCount;
    })();

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('fallback adapter deadlocked')), 3000),
    );

    const frameCount = await Promise.race([iterate, timeout]);

    expect(frameCount).toBeGreaterThan(0);
    expect(adapter.status[0]!.available).toBe(false);
    expect(adapter.status[1]!.available).toBe(true);

    stream.close();
    await adapter.close();
  });

  it('should fall back in the non-streaming (synthesize) path with mismatched sample rates', async () => {
    // FallbackChunkedStream has the same phantom-flush vulnerability as
    // FallbackSynthesizeStream: when the primary's sample rate differs from
    // the adapter's output rate a resampler is created, and flushing an
    // unused resampler can return a ghost frame that masks a silent
    // failure. Exercise the non-streaming adapter.synthesize() path.
    const primary = new MockTTS('primary', 22050);
    primary.shouldFail = true;
    const secondary = new MockTTS('secondary', 24000);
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const chunked = adapter.synthesize('hello world');

    const iterate = (async () => {
      let frameCount = 0;
      for await (const _event of chunked) {
        frameCount++;
      }
      return frameCount;
    })();

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('fallback adapter deadlocked')), 3000),
    );

    const frameCount = await Promise.race([iterate, timeout]);

    expect(frameCount).toBeGreaterThan(0);
    expect(adapter.status[0]!.available).toBe(false);
    expect(adapter.status[1]!.available).toBe(true);

    await adapter.close();
  });

  it('anchors ttfb on the time text was sent to the provider, not when it was pushed', async () => {
    const primary = new MockTTS('primary');
    // Simulate sentence buffering / connection latency between the text being
    // pushed to the TTS node and it actually being sent to the provider.
    primary.sendDelayMs = 120;
    const adapter = new FallbackAdapter({
      ttsInstances: [primary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const stream = adapter.stream();
    const pushTime = performance.now() / 1000;
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello world');
          controller.close();
        },
      }),
    );

    const startedTimes = new Set<unknown>();
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      startedTimes.add(event.frame.userdata[USERDATA_TTS_STARTED_TIME]);
    }

    expect(startedTimes.size).toBe(1);
    const startedTime = [...startedTimes][0];
    // the stamp must be the exact time the underlying stream sent the text to
    // the provider, so the send delay is excluded from downstream TTFB
    expect(startedTime).toBe(primary.lastMarkedTime);
    expect(startedTime as number).toBeGreaterThanOrEqual(pushTime + 0.1);

    stream.close();
    await adapter.close();
  });

  it('keeps the ttfb anchor from a provider that failed after receiving text', async () => {
    const primary = new MockTTS('primary');
    primary.shouldFail = true;
    primary.failAfterInput = true;
    const secondary = new MockTTS('secondary');
    secondary.sendDelayMs = 50;
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const stream = adapter.stream();
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello world');
          controller.close();
        },
      }),
    );

    const startedTimes = new Set<unknown>();
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      startedTimes.add(event.frame.userdata[USERDATA_TTS_STARTED_TIME]);
    }

    // the fallback adapter is measured as a single TTS node: the anchor stays
    // on the first provider that received the text — even though it failed
    // before emitting audio — so failover time counts towards TTFB
    expect(primary.firstMarkedTime).toBeDefined();
    expect(secondary.lastMarkedTime).toBeDefined();
    expect(startedTimes.size).toBe(1);
    const startedTime = [...startedTimes][0];
    expect(startedTime).toBe(primary.firstMarkedTime);
    expect(startedTime as number).toBeLessThan(secondary.lastMarkedTime!);

    stream.close();
    await adapter.close();
  });

  it('stamps chunked synthesis with the submission time, kept across failover', async () => {
    const primary = new MockTTS('primary');
    primary.shouldFail = true;
    const secondary = new MockTTS('secondary');
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const submitTime = performance.now() / 1000;
    const chunked = adapter.synthesize('hello world');

    const startedTimes = new Set<unknown>();
    for await (const event of chunked) {
      startedTimes.add(event.frame.userdata[USERDATA_TTS_STARTED_TIME]);
    }

    // the full text is submitted at creation time; failing over to the
    // secondary must not move the anchor
    expect(startedTimes.size).toBe(1);
    const startedTime = [...startedTimes][0] as number;
    expect(typeof startedTime).toBe('number');
    expect(startedTime).toBeGreaterThanOrEqual(submitTime);
    expect(startedTime).toBeLessThan(submitTime + 0.1);

    await adapter.close();
  });

  it('keeps a child failure off the adapter while another instance can serve', async () => {
    // A non-retryable child error (ElevenLabs 401 in the field report) used to
    // be re-emitted verbatim, so AgentSession closed the session as
    // unrecoverable while this adapter was busy failing over successfully.
    const primary = new MockTTS('primary');
    primary.shouldFail = true;
    primary.failWith = new APIStatusError({
      message: 'payment required',
      options: { statusCode: 401 },
    });
    const secondary = new MockTTS('secondary');
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const adapterErrors: TTSError[] = [];
    adapter.on('error', (error) => adapterErrors.push(error));

    // the failed instance is probed for recovery immediately and the probe
    // fails too, so a downed provider keeps producing child errors long after
    // the utterance it broke
    const childErrors: TTSError[] = [];
    const probeFailed = new Promise<void>((resolve) => {
      primary.on('error', (error) => {
        childErrors.push(error);
        if (childErrors.length === 2) resolve();
      });
    });

    const stream = adapter.stream();
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello world');
          controller.close();
        },
      }),
    );

    let frameCount = 0;
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      frameCount++;
    }
    await probeFailed;

    expect(frameCount).toBeGreaterThan(0);
    expect(childErrors.map((e) => e.recoverable)).toEqual([false, false]);
    expect(adapterErrors).toEqual([]);

    stream.close();
    await adapter.close();
  });

  it('reports an unrecoverable error once every instance has failed', async () => {
    const primary = new MockTTS('primary');
    primary.shouldFail = true;
    const secondary = new MockTTS('secondary');
    secondary.shouldFail = true;
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const adapterErrors: TTSError[] = [];
    adapter.on('error', (error) => adapterErrors.push(error));

    const stream = adapter.stream();
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello world');
          controller.close();
        },
      }),
    );

    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
    }

    expect(adapterErrors).toHaveLength(1);
    expect(adapterErrors[0]!.label).toBe(adapter.label);
    expect(adapterErrors[0]!.recoverable).toBe(false);
    expect(adapterErrors[0]!.error.message).toContain('all TTS instances failed');

    stream.close();
    await adapter.close();
  });

  it('leaves listeners the caller registered on its own instances intact on close', async () => {
    const tts = new MockTTS('primary');
    const onError = () => {};
    const onMetrics = () => {};
    const onFallbackActivated = () => {};
    tts.on('error', onError);
    tts.on('metrics_collected', onMetrics);
    tts.on('fallback_activated', onFallbackActivated);

    const adapter = new FallbackAdapter({ ttsInstances: [tts], recoveryDelayMs: 60_000 });
    await adapter.close();

    expect(tts.listeners('error')).toEqual([onError]);
    expect(tts.listeners('metrics_collected')).toEqual([onMetrics]);
    expect(tts.listeners('fallback_activated')).toEqual([onFallbackActivated]);
  });

  it('falls back from a failing non-streaming instance without leaking a rejection', async () => {
    // A non-streaming instance is synthesized through a StreamAdapter, which
    // re-emits the instance's errors onto itself with nothing listening —
    // Node turns that into a synchronous throw inside the child's emitError.
    // Both that throw and the APIError it displaces come from ChunkedStream's
    // detached main task, so neither may escape as an unhandled rejection.
    const primary = new MockTTS('primary', SAMPLE_RATE, false);
    primary.shouldFail = true;
    const secondary = new MockTTS('secondary');
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const adapterErrors: TTSError[] = [];
    adapter.on('error', (error) => adapterErrors.push(error));
    const probeFailed = new Promise<void>((resolve) => primary.once('error', () => resolve()));

    const stream = adapter.stream();
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello world.');
          controller.close();
        },
      }),
    );

    let frameCount = 0;
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      frameCount++;
    }
    await probeFailed;

    expect(frameCount).toBeGreaterThan(0);
    expect(adapterErrors).toEqual([]);
    expect(unhandledRejections).toEqual([]);

    stream.close();
    await adapter.close();
  });

  it.each([true, false])(
    "logs the provider's own error when a stream fails over and when its recovery probe fails (streaming: %s)",
    async (streaming) => {
      const warn = vi.spyOn(log(), 'warn');
      const debug = vi.spyOn(log(), 'debug');
      const unauthorized = new APIStatusError({
        message: 'payment required',
        options: { statusCode: 401 },
      });
      const primary = new MockTTS('primary', SAMPLE_RATE, streaming);
      primary.shouldFail = true;
      primary.failWith = unauthorized;
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });

      const stream = adapter.stream();
      stream.updateInputStream(
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue('hello world.');
            controller.close();
          },
        }),
      );
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) break;
      }

      const logged = { tts: 'primary', error: unauthorized };
      expect(warn).toHaveBeenCalledWith(logged, 'TTS failed, switching to next instance');
      await vi.waitFor(() =>
        expect(debug).toHaveBeenCalledWith(logged, 'TTS recovery probe failed'),
      );

      stream.close();
      await adapter.close();
    },
  );

  it("logs the provider's own error when chunked synthesis fails over", async () => {
    const warn = vi.spyOn(log(), 'warn');
    const unauthorized = new APIStatusError({
      message: 'payment required',
      options: { statusCode: 401 },
    });
    const primary = new MockTTS('primary');
    primary.shouldFail = true;
    primary.failWith = unauthorized;
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, new MockTTS('secondary')],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    let frameCount = 0;
    for await (const _event of adapter.synthesize('hello world')) {
      frameCount++;
    }

    expect(frameCount).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      { tts: 'primary', error: unauthorized },
      'TTS failed, switching to next instance',
    );

    await adapter.close();
  });

  it("does not log another request's provider error for a silent failure", async () => {
    // Two requests share the primary: B's attempt fails with a 401 while A's
    // produces no audio and reports nothing. The TTS `error` event is shared,
    // so A must be logged with its own no-audio failure, not B's 401.
    const warn = vi.spyOn(log(), 'warn');
    const unauthorized = new APIStatusError({
      message: 'payment required',
      options: { statusCode: 401 },
    });
    const primary = new MockTTS('primary');
    const bFailed = new Promise<void>((resolve) => primary.once('error', () => resolve()));
    primary.synthesize = (text, connOptions) =>
      new ScriptedChunkedStream(primary, text, connOptions, async () => {
        if (text === 'b') throw unauthorized;
        await bFailed;
      });
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, new MockTTS('secondary')],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    const drain = async (text: string) => {
      for await (const _event of adapter.synthesize(text)) {
        // served by the secondary
      }
    };
    await Promise.all([drain('a'), drain('b')]);

    const loggedErrors = warn.mock.calls
      .filter(([, msg]) => msg === 'TTS failed, switching to next instance')
      .map(([fields]) => (fields as { error: Error }).error.message);
    expect(loggedErrors.sort()).toEqual([
      'TTS synthesis completed but no audio was received',
      'payment required',
    ]);

    await adapter.close();
  });

  it("reports a skipped sentence's error even when other sentences delivered audio", async () => {
    const tts = new MockTTS('primary', SAMPLE_RATE, false);
    tts.failWith = new APIStatusError({
      message: 'payment required',
      options: { statusCode: 401 },
    });
    tts.synthesize = (text, connOptions) =>
      new MockChunkedStream(tts, text, text.includes('first'), false, connOptions);
    const adapter = new StreamAdapter(tts, new basic.SentenceTokenizer());
    adapter.on('error', () => {});

    const stream = adapter.stream();
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('The first sentence fails to synthesize. ');
          controller.enqueue('The second sentence comes through fine.');
          controller.close();
        },
      }),
    );
    let frameCount = 0;
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      frameCount++;
    }

    expect(frameCount).toBeGreaterThan(0);
    expect(stream.error).toBe(tts.failWith);

    await adapter.close();
  });

  it.each([
    ['stream', true],
    ['stream', false],
    ['synthesize', true],
  ] as const)(
    'ends the utterance without replaying it when a provider fails after its audio went out (%s, streaming: %s)',
    async (mode, streaming) => {
      const warn = vi.spyOn(log(), 'warn');
      const dropped = new APIConnectionError({ message: 'socket closed mid-utterance' });
      const primary = new MockTTS('primary', SAMPLE_RATE, streaming);
      primary.shouldFail = true;
      primary.failAfterAudio = true;
      primary.failWith = dropped;
      const secondary = new MockTTS('secondary');
      const secondaryStream = vi.spyOn(secondary, 'stream');
      const secondarySynthesize = vi.spyOn(secondary, 'synthesize');
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, secondary],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      const adapterErrors: TTSError[] = [];
      adapter.on('error', (error) => adapterErrors.push(error));
      const availability: AvailabilityChangedEvent[] = [];
      adapter.on('tts_availability_changed', (event) => availability.push(event));

      const { frames, ended } = await request(adapter, mode === 'stream' ? 'streaming' : 'chunked');

      // only the primary's frame: the secondary must not replay the utterance
      expect(frames).toBe(1);
      expect(secondaryStream).not.toHaveBeenCalled();
      expect(secondarySynthesize).not.toHaveBeenCalled();
      if (mode === 'stream') expect(ended).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        { tts: 'primary', error: dropped },
        'TTS failed after audio pushed, ending the utterance without fallback',
      );
      // marked unavailable, so the next request goes to the secondary
      expect(availability).toEqual([{ tts: primary, available: false }]);
      expect(adapter.status[0]!.available).toBe(false);
      // reaches the session's error listeners, but as recoverable: it must not count towards
      // closing the session
      expect(adapterErrors).toHaveLength(1);
      expect(adapterErrors[0]).toMatchObject({
        type: 'tts_error',
        label: adapter.label,
        error: dropped,
        recoverable: true,
      });

      await adapter.close();
    },
  );

  it('does not throw when the adapter has no error listener and a provider fails after audio', async () => {
    const primary = new MockTTS('primary');
    primary.shouldFail = true;
    primary.failAfterAudio = true;
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, new MockTTS('secondary')],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    expect((await request(adapter, 'streaming')).frames).toBe(1);

    await adapter.close();
  });

  it('probes a provider that failed after audio at once, and the probe restores it', async () => {
    const primary = new SequencedTTS('primary', ['fail', 'ok']);
    primary.failAfterAudio = true;
    const secondary = new MockTTS('secondary');
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 0,
    });
    adapter.on('error', () => {});
    const availability: AvailabilityChangedEvent[] = [];
    adapter.on('tts_availability_changed', (event) => availability.push(event));

    expect((await request(adapter, 'streaming')).frames).toBe(1);
    // the failure starts a probe at once, so a dropped socket does not cost the primary the
    // next utterance
    await vi.waitFor(() =>
      expect(availability).toEqual([
        { tts: primary, available: false },
        { tts: primary, available: true },
      ]),
    );
    expect(primary.streamCalls).toBe(2);

    await adapter.close();
  });

  it.each(['chunked', 'streaming'] as const)(
    'keeps an instance available and the request intact when an availability listener throws (%s)',
    async (mode) => {
      const primary = new MockTTS('primary');
      primary.shouldFail = true;
      const adapter = new FallbackAdapter({
        ttsInstances: [primary],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      const errors: TTSError[] = [];
      adapter.on('error', (event) => errors.push(event));
      adapter.on('tts_availability_changed', (event) => {
        if (event.available) throw new Error('listener bug');
      });

      // the only instance fails, and its probe fails too
      await request(adapter, mode);
      await vi.waitFor(() => expect(adapter.status[0]!.recoveringTask!.done).toBe(true));
      expect(adapter.status[0]!.available).toBe(false);
      errors.length = 0;

      // it serves again with every instance down: the success restores it
      primary.shouldFail = false;
      const stream =
        mode === 'chunked' ? adapter.synthesize('hello') : streamText(adapter, 'hello');
      let frames = 0;
      let ends = 0;
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) ends++;
        else frames++;
      }
      stream.close();

      expect(frames).toBe(1);
      expect(ends).toBe(mode === 'streaming' ? 1 : 0);
      expect(adapter.status[0]!.available).toBe(true);
      expect(errors).toEqual([]);
      await adapter.close();
    },
  );

  it('does not run availability listeners inside the probe, so a request they start forwards its notices', async () => {
    const primary = new NotifyingTTS('primary');
    primary.shouldFail = true;
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, new MockTTS('secondary')],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 0,
    });
    const voices: string[] = [];
    adapter.on('fallback_activated', (event) => voices.push(event.voice));
    let fromListener: Promise<unknown> | undefined;
    adapter.on('tts_availability_changed', (event) => {
      if (event.available) fromListener = request(adapter, 'chunked', 'from-listener');
    });

    await request(adapter, 'chunked', 'first');
    await vi.waitFor(() => expect(adapter.status[0]!.recoveringTask!.done).toBe(true));
    primary.shouldFail = false;
    await request(adapter, 'chunked', 'second');
    await vi.waitFor(() => expect(fromListener).toBeDefined());
    await fromListener;

    expect(voices).toContain('from-listener');
    await adapter.close();
  });

  it.each(['chunked', 'streaming'] as const)(
    'fails over, without flushing a fragment, when a resampled provider fails before delivering audio (%s)',
    async (mode) => {
      // 22050 Hz into 48000 Hz with the real resampler: one raw frame is buffered, and a flush
      // would push it to the caller as a fragment and end the utterance
      const primary = new MockTTS('primary', 22050);
      primary.shouldFail = true;
      primary.failAfterAudio = true;
      const secondary = new MockTTS('secondary', 48000);
      const served = vi.spyOn(secondary, mode === 'chunked' ? 'synthesize' : 'stream');
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, secondary],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      adapter.on('error', () => {});

      const result = await request(adapter, mode);

      expect(served).toHaveBeenCalledTimes(1);
      expect(result.frames).toBe(1);
      await adapter.close();
    },
  );

  it('does not count a recovery probe that errors after some audio as recovered', async () => {
    const debug = vi.spyOn(log(), 'debug');
    const dropped = new APIConnectionError({ message: 'socket closed mid-utterance' });
    const primary = new MockTTS('primary');
    primary.shouldFail = true;
    primary.failAfterAudio = true;
    primary.failWith = dropped;
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, new MockTTS('secondary')],
      recoveryDelayMs: 60_000,
    });

    adapter.markUnAvailable(0);
    // a request skips the unavailable primary and probes it
    await request(adapter, 'streaming');
    await vi.waitFor(() =>
      expect(debug).toHaveBeenCalledWith(
        { tts: 'primary', error: dropped },
        'TTS recovery probe failed',
      ),
    );
    expect(adapter.status[0]!.available).toBe(false);

    await adapter.close();
  });

  it('unsubscribes the StreamAdapter around a non-streaming instance after each attempt', async () => {
    // one failover, then two utterances that skip the downed primary
    const primary = new MockTTS('primary', SAMPLE_RATE, false);
    primary.shouldFail = true;
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, new MockTTS('secondary')],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });

    for (let i = 0; i < 3; i++) {
      const stream = adapter.stream();
      stream.updateInputStream(
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue('hello world.');
            controller.close();
          },
        }),
      );
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) break;
      }
      stream.close();
    }
    await adapter.close();

    await vi.waitFor(() => {
      expect(primary.listenerCount('error')).toBe(0);
      expect(primary.listenerCount('metrics_collected')).toBe(0);
      expect(primary.listenerCount('fallback_activated')).toBe(0);
    });
  });

  it('names the instance that served in the usage metrics, not the one preferred next', async () => {
    class IdentifiedTTS extends MockTTS {
      constructor(
        label: string,
        private readonly _model: string,
        private readonly _provider: string,
      ) {
        super(label);
      }
      override get model(): string {
        return this._model;
      }
      override get provider(): string {
        return this._provider;
      }
    }
    const primary = new IdentifiedTTS('primary', 'primary-model', 'primary');
    primary.shouldFail = true;
    const secondary = new IdentifiedTTS('secondary', 'secondary-model', 'secondary');
    const adapter = new FallbackAdapter({
      ttsInstances: [primary, secondary],
      maxRetryPerTTS: 0,
      recoveryDelayMs: 60_000,
    });
    const metrics: Array<{
      label: string;
      metadata?: { modelName?: string; modelProvider?: string };
    }> = [];
    adapter.on('metrics_collected', (m) => metrics.push(m));

    const stream = adapter.stream();
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('hello world');
          controller.close();
        },
      }),
    );
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
    }
    // the primary is preferred again as soon as its probe succeeds; the request the secondary
    // served must still say so
    adapter.status[0]!.available = true;
    await delay(20);

    expect(metrics.some((metric) => metric.label === adapter.label)).toBe(false);
    expect(metrics.filter((metric) => metric.label === secondary.label)).toEqual([
      expect.objectContaining({
        label: secondary.label,
        metadata: { modelName: 'secondary-model', modelProvider: 'secondary' },
      }),
    ]);
    stream.close();
    await adapter.close();
  });

  it('attributes partial chunked audio to the instance the caller heard', async () => {
    // chunked synthesis that fails after emitting audio cannot fall back (the audio was heard);
    // the request and caller spans still name the instance that produced it
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    const previous = tracer.getProvider();
    setTracerProvider(provider);
    try {
      const primary = new MockTTS('primary');
      primary.shouldFail = true;
      primary.failAfterAudio = true;
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      await tracer.startActiveSpan(
        async () => {
          const stream = adapter.synthesize('hello world');
          try {
            for await (const _frame of stream) {
              // drain
            }
          } catch {
            // the partial failure is reported to the caller
          }
        },
        { name: 'caller' },
      );
      await adapter.close();
      const caller = exporter.getFinishedSpans().find((span) => span.name === 'caller');
      expect(caller?.attributes[traceTypes.ATTR_GEN_AI_RESPONSE_MODEL]).toBe(primary.model);
    } finally {
      setTracerProvider(previous);
      await provider.shutdown();
      trace.disable();
      otelContext.disable();
    }
  });

  it('reports the model and provider of the instance that serves next', () => {
    class IdentifiedTTS extends MockTTS {
      constructor(
        label: string,
        private readonly _model: string,
        private readonly _provider: string,
      ) {
        super(label);
      }
      override get model(): string {
        return this._model;
      }
      override get provider(): string {
        return this._provider;
      }
    }
    const primary = new IdentifiedTTS('primary', 'primary-model', 'primary');
    const fallback = new IdentifiedTTS('fallback', 'fallback-model', 'fallback');
    const adapter = new FallbackAdapter({ ttsInstances: [primary, fallback] });
    expect(adapter.model).toBe('primary-model');
    expect(adapter.provider).toBe('primary');
    expect(adapter.label).toContain('FallbackAdapter');
    adapter.status[0]!.available = false;
    expect(adapter.model).toBe('fallback-model');
    expect(adapter.provider).toBe('fallback');
    // once the primary recovers (its recovery task flips it back to available) the next request
    // goes to it first, so that is what model and provider report
    adapter.status[0]!.available = true;
    expect(adapter.model).toBe('primary-model');
  });

  describe('failover and availability', () => {
    it.each(['chunked', 'streaming'] as const)(
      'fails over and reports availability, then an error once every instance has failed (%s)',
      async (mode) => {
        // port of Python's test_tts_fallback / test_tts_stream_fallback
        const primary = new MockTTS('primary');
        primary.shouldFail = true;
        const secondary = new MockTTS('secondary');
        const adapter = new FallbackAdapter({
          ttsInstances: [primary, secondary],
          maxRetryPerTTS: 0,
          recoveryDelayMs: 60_000,
        });
        const availability: AvailabilityChangedEvent[] = [];
        adapter.on('tts_availability_changed', (event) => availability.push(event));
        const adapterErrors: TTSError[] = [];
        adapter.on('error', (error) => adapterErrors.push(error));

        expect((await request(adapter, mode)).frames).toBeGreaterThan(0);
        expect(availability).toEqual([{ tts: primary, available: false }]);
        expect(adapterErrors).toEqual([]);

        secondary.shouldFail = true;
        expect((await request(adapter, mode)).frames).toBe(0);
        expect(availability).toEqual([
          { tts: primary, available: false },
          { tts: secondary, available: false },
        ]);
        expect(adapterErrors).toHaveLength(1);
        expect(adapterErrors[0]).toMatchObject({ recoverable: false });
        expect(adapterErrors[0]!.error.message).toContain('all TTS instances failed');

        await adapter.close();
      },
    );

    it.each([
      ['chunked', 'synthesize'],
      ['streaming', 'stream'],
    ] as const)(
      'fails over on a plain error thrown by the provider, and logs it at error level with its stack (%s)',
      async (mode, method) => {
        const logError = vi.spyOn(log(), 'error');
        const bug = new TypeError("cannot read properties of undefined (reading 'voice')");
        const primary = new MockTTS('primary');
        primary[method] = () => {
          throw bug;
        };
        const secondary = new MockTTS('secondary');
        const adapter = new FallbackAdapter({
          ttsInstances: [primary, secondary],
          maxRetryPerTTS: 0,
          recoveryDelayMs: 60_000,
        });
        const adapterErrors: TTSError[] = [];
        adapter.on('error', (error) => adapterErrors.push(error));
        const availability: AvailabilityChangedEvent[] = [];
        adapter.on('tts_availability_changed', (event) => availability.push(event));

        expect((await request(adapter, mode)).frames).toBeGreaterThan(0);

        const logged = logError.mock.calls.find(
          ([, msg]) => msg === 'TTS failed with an unexpected error, switching to next instance',
        );
        expect(logged).toBeDefined();
        const fields = logged![0] as { tts: string; error: Error };
        expect(fields.tts).toBe('primary');
        expect(fields.error).toBe(bug);
        expect(fields.error.stack).toContain('TypeError');
        expect(availability).toEqual([{ tts: primary, available: false }]);
        expect(adapterErrors).toEqual([]);

        await adapter.close();
      },
    );

    it.each(['chunked', 'streaming'] as const)(
      'restores an instance that serves a request once every instance is down (%s)',
      async (mode) => {
        const primary = new MockTTS('primary');
        primary.shouldFail = true;
        const secondary = new MockTTS('secondary');
        secondary.shouldFail = true;
        const adapter = new FallbackAdapter({
          ttsInstances: [primary, secondary],
          maxRetryPerTTS: 0,
          recoveryDelayMs: 60_000,
        });
        adapter.on('error', () => {});
        const availability: AvailabilityChangedEvent[] = [];
        adapter.on('tts_availability_changed', (event) => availability.push(event));

        expect((await request(adapter, mode)).frames).toBe(0);
        expect(adapter.status.map((status) => status.available)).toEqual([false, false]);

        // every instance is down, so none is skipped and none is probed: all are retried, and the
        // secondary is the one that serves
        secondary.shouldFail = false;
        expect((await request(adapter, mode)).frames).toBeGreaterThan(0);
        expect(adapter.status.map((status) => status.available)).toEqual([false, true]);
        expect(availability.at(-1)).toEqual({ tts: secondary, available: true });

        // the next requests go straight to the secondary, not the dead primary first
        const attempts = vi.spyOn(primary, mode === 'chunked' ? 'synthesize' : 'stream');
        expect((await request(adapter, mode)).frames).toBeGreaterThan(0);
        expect((await request(adapter, mode)).frames).toBeGreaterThan(0);
        expect(attempts).not.toHaveBeenCalled();

        await adapter.close();
      },
    );

    it.each(['chunked', 'streaming'] as const)(
      'tries an instance it skipped as unavailable as a last resort before failing (%s)',
      async (mode) => {
        const method = mode === 'chunked' ? 'synthesize' : 'stream';
        const primary = new MockTTS('primary');
        primary.shouldFail = true;
        const secondary = new MockTTS('secondary');
        secondary.shouldFail = true;
        const adapter = new FallbackAdapter({
          ttsInstances: [primary, secondary],
          maxRetryPerTTS: 0,
          recoveryDelayMs: 60_000,
        });
        const adapterErrors: TTSError[] = [];
        adapter.on('error', (error) => adapterErrors.push(error));

        // a total outage; both recover, and the primary serves the next request and is restored
        expect((await request(adapter, mode)).frames).toBe(0);
        expect(adapter.status.map((status) => status.available)).toEqual([false, false]);
        await vi.waitFor(() =>
          expect(adapter.status.every((status) => status.recoveringTask!.done)).toBe(true),
        );
        primary.shouldFail = false;
        secondary.shouldFail = false;
        expect((await request(adapter, mode)).frames).toBeGreaterThan(0);
        expect(adapter.status.map((status) => status.available)).toEqual([true, false]);
        adapterErrors.length = 0;

        // the primary fails alone: the request skips the secondary as unavailable, and as the
        // primary was the only instance tried, the secondary serves it as a last resort
        primary.shouldFail = true;
        const probes = vi.spyOn(adapter, 'tryRecovery').mockImplementation(() => {});
        const secondaryAttempts = vi.spyOn(secondary, method);
        expect((await request(adapter, mode)).frames).toBeGreaterThan(0);
        expect(secondaryAttempts).toHaveBeenCalledTimes(1);
        // the primary's failure starts a probe, and the skip of the secondary another
        expect(probes.mock.calls.map(([index]) => index)).toEqual([0, 1]);
        expect(adapter.status.map((status) => status.available)).toEqual([false, true]);
        expect(adapterErrors).toEqual([]);

        await adapter.close();
      },
    );

    it.each(['chunked', 'streaming'] as const)(
      'tries every instance once, then reports one unrecoverable error, when all fail with one skipped (%s)',
      async (mode) => {
        const method = mode === 'chunked' ? 'synthesize' : 'stream';
        const primary = new MockTTS('primary');
        primary.shouldFail = true;
        const secondary = new MockTTS('secondary');
        secondary.shouldFail = true;
        const third = new MockTTS('third');
        third.shouldFail = true;
        const adapter = new FallbackAdapter({
          ttsInstances: [primary, secondary, third],
          maxRetryPerTTS: 0,
          recoveryDelayMs: 60_000,
        });
        vi.spyOn(adapter, 'tryRecovery').mockImplementation(() => {});
        adapter.markUnAvailable(1);
        const adapterErrors: TTSError[] = [];
        adapter.on('error', (error) => adapterErrors.push(error));
        const attempts = [primary, secondary, third].map((tts) => vi.spyOn(tts, method));
        const order: string[] = [];
        attempts.forEach((spy, i) =>
          spy.mockImplementation(function (this: TTS, ...args: []) {
            order.push(['primary', 'secondary', 'third'][i]!);
            return TTS.prototype[method].apply(this, args as never);
          }),
        );

        expect((await request(adapter, mode)).frames).toBe(0);

        // the available ones first, then the skipped one
        expect(order).toEqual(['primary', 'third', 'secondary']);
        expect(adapterErrors).toHaveLength(1);
        expect(adapterErrors[0]).toMatchObject({ recoverable: false });
        expect(adapterErrors[0]!.error.message).toContain('all TTS instances failed');

        await adapter.close();
      },
    );

    it.each(['chunked', 'streaming'] as const)(
      'does not count a request that no frame reached the caller as served (%s)',
      async (mode) => {
        // the provider's frames all vanish in a resampler that is still buffering, so nothing
        // reached the caller; the installed AudioResampler always flushes a frame once audio went
        // in, so a stand-in models it
        const primary = new MockTTS('primary', 22050);
        const adapter = new FallbackAdapter({
          ttsInstances: [primary, new MockTTS('secondary', 24000)],
          maxRetryPerTTS: 0,
          recoveryDelayMs: 60_000,
        });
        const buffering = { push: () => [], flush: () => [], close: () => {} };
        vi.spyOn(adapter, 'createResamplerForTTS').mockImplementation((index) =>
          index === 0 ? (buffering as unknown as AudioResampler) : null,
        );
        adapter.markUnAvailable(0);
        adapter.markUnAvailable(1);
        const availability: AvailabilityChangedEvent[] = [];
        adapter.on('tts_availability_changed', (event) => availability.push(event));

        // every instance is down, so the primary is tried and its request ends with no audio
        expect((await request(adapter, mode)).frames).toBe(0);

        expect(adapter.status.map((status) => status.available)).toEqual([false, false]);
        expect(availability).toEqual([]);

        await adapter.close();
      },
    );

    it('does not count a streamed request without text as served, when no provider call is made', async () => {
      // a non-streaming instance runs under a StreamAdapter, which makes no provider call for
      // blank text, so the request ends with no audio
      const primary = new MockTTS('primary', SAMPLE_RATE, false);
      const adapter = new FallbackAdapter({
        ttsInstances: [primary],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      adapter.markUnAvailable(0);
      const attempts = vi.spyOn(primary, 'synthesize');

      expect(await request(adapter, 'streaming', '   ')).toEqual({ frames: 0, ended: true });
      expect(await request(adapter, 'chunked', '   ')).toEqual({ frames: 0, ended: false });

      expect(attempts).not.toHaveBeenCalled();
      expect(adapter.status[0]!.available).toBe(false);

      await adapter.close();
    });

    it.each([
      ['chunked', 1, false],
      ['chunked', 2, true],
      ['streaming', 1, false],
      ['streaming', 2, true],
    ] as const)(
      'reports a failure after audio as recoverable only with another instance to serve next (%s, %i instance)',
      async (mode, count, recoverable) => {
        const ttsInstances = Array.from({ length: count }, (_, i) => new MockTTS(`tts-${i}`));
        ttsInstances[0]!.shouldFail = true;
        ttsInstances[0]!.failAfterAudio = true;
        const adapter = new FallbackAdapter({
          ttsInstances,
          maxRetryPerTTS: 0,
          recoveryDelayMs: 60_000,
        });
        const errors: TTSError[] = [];
        adapter.on('error', (error) => errors.push(error));

        expect((await request(adapter, mode)).frames).toBe(1);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ type: 'tts_error', recoverable });

        await adapter.close();
      },
    );

    it('reports one recoverable error when a non-streaming provider fails after audio, under a StreamAdapter', async () => {
      // `ttsNode` wraps a non-streaming adapter in a StreamAdapter, which re-emits the adapter's
      // errors on itself: with no listener there, that emit threw and the stream failed a second time
      const primary = new MockTTS('primary', SAMPLE_RATE, false);
      primary.shouldFail = true;
      primary.failAfterAudio = true;
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary', SAMPLE_RATE, false)],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      expect(adapter.capabilities.streaming).toBe(false);
      const wrapped = new StreamAdapter(adapter, new basic.SentenceTokenizer());
      // after the StreamAdapter: a throwing forwarder would skip the listeners behind it
      const errors: TTSError[] = [];
      adapter.on('error', (error) => errors.push(error));

      const stream = streamText(wrapped, 'hello world.');
      let ended = false;
      let frames = 0;
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) {
          ended = true;
          break;
        }
        frames++;
      }

      expect(frames).toBe(1);
      expect(ended).toBe(true);
      expect(stream.error).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: 'tts_error', recoverable: true });
      expect(unhandledRejections).toEqual([]);

      stream.close();
      await wrapped.close();
      await adapter.close();
    });

    it('still ends the utterance when an error listener throws after a failure after audio', async () => {
      const primary = new MockTTS('primary');
      primary.shouldFail = true;
      primary.failAfterAudio = true;
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      adapter.on('error', () => {
        throw new Error('listener bug');
      });

      expect(await request(adapter, 'streaming')).toEqual({ frames: 1, ended: true });
      expect(unhandledRejections).toEqual([]);

      await adapter.close();
    });

    it('falls back from a chunked provider that fails before its resampler yields a frame', async () => {
      // the provider produced audio, but none reached the caller, so another instance can still
      // serve the whole utterance. The installed AudioResampler always flushes a frame once audio
      // went in, so a stand-in that yields nothing models a resampler still buffering
      const primary = new MockTTS('primary', 22050);
      primary.shouldFail = true;
      primary.failAfterAudio = true;
      const secondary = new MockTTS('secondary', 24000);
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, secondary],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      const buffering = { push: () => [], flush: () => [], close: () => {} };
      vi.spyOn(adapter, 'createResamplerForTTS').mockImplementation((index) =>
        index === 0 ? (buffering as unknown as AudioResampler) : null,
      );
      const errors: TTSError[] = [];
      adapter.on('error', (error) => errors.push(error));

      const result = await request(adapter, 'chunked');

      expect(result.frames).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      expect(adapter.status.map((status) => status.available)).toEqual([false, true]);

      await adapter.close();
    });

    it('does not log an API error at error level when failing over', async () => {
      const logError = vi.spyOn(log(), 'error');
      const primary = new MockTTS('primary');
      primary.shouldFail = true;
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });

      await request(adapter, 'streaming');

      expect(logError).not.toHaveBeenCalled();
      await adapter.close();
    });
  });

  describe('recovery probes', () => {
    it.each(['chunked', 'streaming'] as const)(
      'restores a failed instance when a later request probes it (%s)',
      async (mode) => {
        // port of Python's test_tts_recover / test_tts_recover_on_streamed_path
        const primary = new MockTTS('primary');
        primary.shouldFail = true;
        const adapter = new FallbackAdapter({
          ttsInstances: [primary, new MockTTS('secondary')],
          maxRetryPerTTS: 0,
          recoveryDelayMs: 0,
        });
        const availability: AvailabilityChangedEvent[] = [];
        adapter.on('tts_availability_changed', (event) => availability.push(event));

        await request(adapter, mode);
        expect(availability).toEqual([{ tts: primary, available: false }]);

        // healthy again, but nothing probes it until a request skips it
        primary.shouldFail = false;
        await delay(50);
        expect(availability).toHaveLength(1);
        expect(adapter.status[0]!.available).toBe(false);

        await request(adapter, mode);
        await vi.waitFor(() =>
          expect(availability).toEqual([
            { tts: primary, available: false },
            { tts: primary, available: true },
          ]),
        );

        // the next request goes to the primary again, with no further events
        const servedByPrimary = vi.spyOn(primary, mode === 'chunked' ? 'synthesize' : 'stream');
        await request(adapter, mode);
        expect(servedByPrimary).toHaveBeenCalledTimes(1);
        expect(availability).toHaveLength(2);

        await adapter.close();
      },
    );

    it('restores a TTS that only implements stream(), as inference.TTS does', async () => {
      // the probe used synthesize(), which inference.TTS lacks: it never recovered
      const primary = new StreamOnlyTTS('primary');
      primary.shouldFail = true;
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 0,
      });
      const availability: AvailabilityChangedEvent[] = [];
      adapter.on('tts_availability_changed', (event) => availability.push(event));

      await request(adapter, 'streaming');
      primary.shouldFail = false;
      await request(adapter, 'streaming');

      await vi.waitFor(() =>
        expect(availability).toEqual([
          { tts: primary, available: false },
          { tts: primary, available: true },
        ]),
      );

      await adapter.close();
    });

    it('sends no probes while idle', async () => {
      const primary = new MockTTS('primary');
      primary.shouldFail = true;
      const attempts = vi.spyOn(primary, 'stream');
      const synthesize = vi.spyOn(primary, 'synthesize');
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 10,
      });

      await request(adapter, 'streaming');
      await delay(150);

      // the failed attempt and its one probe; a timer would have probed again by now
      expect(attempts.mock.calls.length + synthesize.mock.calls.length).toBe(2);

      await adapter.close();
    });

    it.each(['chunked', 'streaming'] as const)(
      'starts probes of one instance at least recoveryDelayMs apart (%s)',
      async (mode) => {
        let now = 1_000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const primary = new MockTTS('primary');
        primary.shouldFail = true;
        const stream = vi.spyOn(primary, 'stream');
        const synthesize = vi.spyOn(primary, 'synthesize');
        const calls = () => stream.mock.calls.length + synthesize.mock.calls.length;
        const adapter = new FallbackAdapter({
          ttsInstances: [primary, new MockTTS('secondary')],
          maxRetryPerTTS: 0,
          recoveryDelayMs: 1_000,
        });
        const probeDone = () => adapter.status[0]!.recoveringTask!.done;

        // the failed attempt, then the probe it starts
        await request(adapter, mode);
        await vi.waitFor(() => expect(probeDone()).toBe(true));
        expect(calls()).toBe(2);

        // requests that skip the primary within the interval start no probe
        await request(adapter, mode);
        now += 999;
        await request(adapter, mode);
        expect(calls()).toBe(2);

        now += 1;
        await request(adapter, mode);
        expect(calls()).toBe(3);

        await adapter.close();
      },
    );

    it('runs one probe per instance at a time, and close() cancels it and starts no more', async () => {
      // port of Python's test_no_recovery_probe_after_close
      const primary = new SequencedTTS('primary', ['fail', 'block']);
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 0,
      });

      await request(adapter, 'streaming');
      await vi.waitFor(() => expect(primary.streamCalls).toBe(2));
      const probe = adapter.status[0]!.recoveringTask!;
      expect(probe.done).toBe(false);

      // the probe is still in flight: skipping requests start no second one
      await request(adapter, 'streaming');
      await request(adapter, 'streaming');
      expect(primary.streamCalls).toBe(2);

      await adapter.close();
      expect(probe.done).toBe(true);
      expect(adapter.status[0]!.available).toBe(false);

      // a request that still runs after close starts no probe
      await request(adapter, 'streaming');
      expect(primary.streamCalls).toBe(2);
    });

    it('does not count a probe that gets some audio and then hangs as recovered', async () => {
      const primary = new FrameThenHangTTS('primary');
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        recoveryDelayMs: 60_000,
      });
      const availability: AvailabilityChangedEvent[] = [];
      adapter.on('tts_availability_changed', (event) => availability.push(event));
      adapter.markUnAvailable(0);

      vi.useFakeTimers();
      try {
        adapter.tryRecovery(0);
        const probe = adapter.status[0]!.recoveringTask!;
        await vi.advanceTimersByTimeAsync(9_000);
        // the probe got its frame and is still waiting for the stream to finish
        expect(primary.frames).toBe(1);
        expect(probe.done).toBe(false);

        // the timeout closes the stream, which then ends like a finished one
        await vi.advanceTimersByTimeAsync(1_000);
        await probe.result;
      } finally {
        vi.useRealTimers();
      }

      expect(adapter.status[0]!.available).toBe(false);
      expect(availability).toEqual([{ tts: primary, available: false }]);

      await adapter.close();
    });

    it('drops a probe notice while a user attempt is serving on the same instance', async () => {
      // the real event path: `inference.TTS` emits `fallback_activated` from the recv task of
      // each stream, on a websocket connection of its own. The gateway notice names the text it
      // was sent, so a notice can be told apart by its voice.
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      const answer = (socket: import('ws').WebSocket, voice: string) => {
        socket.send(JSON.stringify({ type: 'session.created', session_id: 's' }));
        socket.send(
          JSON.stringify({
            type: 'fallback_activated',
            session_id: 's',
            fallback_type: 'fallback',
            provider: 'deepgram',
            model: 'deepgram/aura-2',
            voice,
            cause: 'provider_error',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'output_audio',
            session_id: 's',
            audio: Buffer.alloc(3200).toString('base64'),
          }),
        );
        socket.send(JSON.stringify({ type: 'done', session_id: 's' }));
      };
      server.on('connection', (socket) => {
        let transcript = '';
        socket.on('message', (raw) => {
          const event = JSON.parse(raw.toString()) as { type: string; transcript?: string };
          if (event.type === 'input_transcript') transcript = event.transcript!.trim();
          if (event.type !== 'session.flush') return;
          if (transcript === 'user one') {
            // the first request fails, which starts the probe
            socket.terminate();
          } else if (transcript === 'user two') {
            answer(socket, transcript);
          } else {
            // the probe's text: its notice arrives while the second request is waiting for input
            setTimeout(() => answer(socket, 'probe'), 150);
          }
        });
      });

      const primary = new InferenceTTS({
        model: 'cartesia/sonic',
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseURL: `http://127.0.0.1:${port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1_000 },
      });
      const adapter = new FallbackAdapter({
        ttsInstances: [primary],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      adapter.on('error', () => {});
      const voices: string[] = [];
      adapter.on('fallback_activated', (event) => voices.push(event.voice));

      try {
        const first = await request(adapter, 'streaming', 'user one');
        expect(first.frames).toBe(0);
        expect(adapter.status[0]!.available).toBe(false);

        // everything is down, so the primary is retried, with its probe still in flight
        const probe = adapter.status[0]!.recoveringTask!;
        expect(probe.done).toBe(false);
        const second = adapter.stream();
        // the text arrives after the probe's notice, so the attempt is serving when it does
        second.updateInputStream(
          new ReadableStream<string>({
            async start(controller) {
              await delay(400);
              controller.enqueue('user two');
              controller.close();
            },
          }),
        );
        for await (const event of second) {
          if (event === SynthesizeStream.END_OF_STREAM) break;
        }
        await probe.result;
        second.close();

        expect(voices).toEqual(['user two']);
      } finally {
        await adapter.close();
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('closes the StreamAdapter around a non-streaming instance after a probe', async () => {
      const primary = new MockTTS('primary', SAMPLE_RATE, false);
      primary.shouldFail = true;
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 0,
      });
      adapter.on('tts_availability_changed', () => {});

      await request(adapter, 'streaming');
      primary.shouldFail = false;
      await request(adapter, 'streaming');
      await vi.waitFor(() => expect(adapter.status[0]!.available).toBe(true));
      await vi.waitFor(() => expect(adapter.status[0]!.recoveringTask!.done).toBe(true));

      // the probe's StreamAdapter unsubscribed from the instance; the instance itself stays open
      expect(primary.listenerCount('metrics_collected')).toBe(1);
      expect(primary.closeCount).toBe(0);

      await adapter.close();
    });
  });
});
