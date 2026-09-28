// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError, APIStatusError } from '../_exceptions.js';
import { initializeLogger, log } from '../log.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import { basic } from '../tokenize/index.js';
import type { APIConnectOptions } from '../types.js';
import { USERDATA_TTS_STARTED_TIME } from '../types.js';
import { delay } from '../utils.js';
import { FallbackAdapter } from './fallback_adapter.js';
import { StreamAdapter } from './stream_adapter.js';
import { ChunkedStream, SynthesizeStream, TTS, type TTSError } from './tts.js';

const SAMPLE_RATE = 24000;

class MockSynthesizeStream extends SynthesizeStream {
  label = 'mock.SynthesizeStream';

  constructor(
    private mockTts: MockTTS,
    private shouldFail: boolean,
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
  }

  protected async run(): Promise<void> {
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
    connOptions?: APIConnectOptions,
  ) {
    super(text, mockTts, connOptions);
  }
  protected async run(): Promise<void> {
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

  constructor(label: string, sampleRate: number = SAMPLE_RATE, streaming = true) {
    super(sampleRate, 1, { streaming });
    this.label = label;
  }

  synthesize(text: string, connOptions?: APIConnectOptions): ChunkedStream {
    return new MockChunkedStream(this, text, this.shouldFail, connOptions);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new MockSynthesizeStream(this, this.shouldFail, options?.connOptions);
  }
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
    expect(primary.lastMarkedTime).toBeDefined();
    expect(secondary.lastMarkedTime).toBeDefined();
    expect(startedTimes.size).toBe(1);
    const startedTime = [...startedTimes][0];
    expect(startedTime).toBe(primary.lastMarkedTime);
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
    tts.on('error', onError);
    tts.on('metrics_collected', onMetrics);

    const adapter = new FallbackAdapter({ ttsInstances: [tts], recoveryDelayMs: 60_000 });
    await adapter.close();

    expect(tts.listeners('error')).toEqual([onError]);
    expect(tts.listeners('metrics_collected')).toEqual([onMetrics]);
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
    "logs the provider's own error when a stream fails over and when recovery fails (streaming: %s)",
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
        expect(debug).toHaveBeenCalledWith(logged, 'TTS recovery failed, will retry'),
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
      new MockChunkedStream(tts, text, text.includes('first'), connOptions);
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
    'reports a provider failure that cuts off delivered audio, without replaying it (%s, streaming: %s)',
    async (mode, streaming) => {
      const logError = vi.spyOn(log(), 'error');
      const dropped = new APIConnectionError({ message: 'socket closed mid-utterance' });
      const primary = new MockTTS('primary', SAMPLE_RATE, streaming);
      primary.shouldFail = true;
      primary.failAfterAudio = true;
      primary.failWith = dropped;
      const adapter = new FallbackAdapter({
        ttsInstances: [primary, new MockTTS('secondary')],
        maxRetryPerTTS: 0,
        recoveryDelayMs: 60_000,
      });
      const adapterErrors: TTSError[] = [];
      adapter.on('error', (error) => adapterErrors.push(error));

      let frameCount = 0;
      if (mode === 'stream') {
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
          frameCount++;
        }
      } else {
        for await (const _event of adapter.synthesize('hello world.')) {
          frameCount++;
        }
      }

      // only the primary's frame: the secondary must not replay the utterance
      expect(frameCount).toBe(1);
      expect(logError).toHaveBeenCalledWith(
        { tts: 'primary', error: dropped },
        'TTS failed after audio pushed, cannot fallback mid-utterance',
      );
      expect(adapterErrors.map((e) => e.recoverable)).toEqual([false]);

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
    await vi.waitFor(() =>
      expect(debug).toHaveBeenCalledWith(
        { tts: 'primary', error: dropped },
        'TTS recovery failed, will retry',
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

    const own = metrics.filter((m) => m.label === adapter.label);
    expect(own.length).toBeGreaterThan(0);
    for (const m of own) {
      expect(m.metadata?.modelName).toBe('secondary-model');
      expect(m.metadata?.modelProvider).toBe('secondary');
    }
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
});
