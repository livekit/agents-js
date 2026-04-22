// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { beforeAll, describe, expect, it } from 'vitest';
import { APIError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { FallbackAdapter } from './fallback_adapter.js';
import { ChunkedStream, SynthesizeStream, TTS } from './tts.js';

const SAMPLE_RATE = 24000;

class MockSynthesizeStream extends SynthesizeStream {
  label = 'mock.SynthesizeStream';

  constructor(
    private mockTts: MockTTS,
    private shouldFail: boolean,
    private emitAudio: boolean,
    connOptions?: APIConnectOptions,
  ) {
    super(mockTts, connOptions);
  }

  protected async run(): Promise<void> {
    if (this.shouldFail) {
      // Throw immediately, before any pushText has been called.
      // This is the scenario that previously deadlocked the FallbackAdapter:
      // the inner stream's mainTask finishes before forwardBufferToTTS gets
      // a chance to call pushText, so #monitorMetricsTask never starts and
      // this.output is never closed.
      throw new APIError('mock TTS failed immediately');
    }

    // Happy path: read text from this.input and emit a single audio frame per token.
    for await (const data of this.input) {
      if (this.abortController.signal.aborted) break;
      if (data === SynthesizeStream.FLUSH_SENTINEL) continue;
      if (!this.emitAudio) continue;
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
    private emitAudio: boolean,
    connOptions?: APIConnectOptions,
  ) {
    super(text, mockTts, connOptions);
  }
  protected async run(): Promise<void> {
    if (this.shouldFail) {
      throw new APIError('mock TTS failed immediately');
    }
    if (!this.emitAudio) return;
    this.queue.put({
      requestId: 'mock-req',
      segmentId: 'mock-seg',
      frame: new AudioFrame(new Int16Array(160), this.mockTts.sampleRate, 1, 160),
      final: true,
    });
  }
}

class MockTTS extends TTS {
  label: string;
  shouldFail = false;
  emitAudio = true;

  constructor(label: string, sampleRate: number = SAMPLE_RATE) {
    super(sampleRate, 1, { streaming: true });
    this.label = label;
  }

  synthesize(text: string, connOptions?: APIConnectOptions): ChunkedStream {
    return new MockChunkedStream(this, text, this.shouldFail, this.emitAudio, connOptions);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new MockSynthesizeStream(this, this.shouldFail, this.emitAudio, options?.connOptions);
  }
}

describe('TTS FallbackAdapter', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    // Suppress unhandled rejections from background tasks inside SynthesizeStream
    process.on('unhandledRejection', () => {});
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

  it('should not mark the primary unavailable when closed before any audio is received', async () => {
    // A caller interruption within the window between text push and first
    // audio frame (TTFA) must be treated as a clean abort, not a silent
    // provider failure. Previously the `!sawRawAudio` guard raised
    // APIConnectionError on abort, which the outer catch translated into
    // markUnAvailable(primary) — forcing subsequent utterances onto the
    // fallback for the recovery window.
    const primary = new MockTTS('primary');
    primary.emitAudio = false;
    const secondary = new MockTTS('secondary');
    secondary.emitAudio = false;
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
          // Keep the input stream open so the adapter does not naturally
          // flush; abort is the only path to completion.
        },
      }),
    );

    // Drain the output in the background so the adapter's mainTask is not
    // starved on output backpressure.
    const iterate = (async () => {
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) break;
      }
    })();

    // Let forwardBufferToTTS push the token into the inner stream.
    await new Promise((r) => setTimeout(r, 50));

    // Simulate a caller interruption before any audio has been produced.
    stream.close();

    // Wait long enough for the adapter's mainTask to fully unwind both TTS
    // instances — long enough to exercise the buggy markUnAvailable path
    // that would otherwise mark the primary (and secondary) unavailable.
    await iterate;
    await new Promise((r) => setTimeout(r, 200));

    expect(adapter.status[0]!.available).toBe(true);
    expect(adapter.status[1]!.available).toBe(true);

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
});
