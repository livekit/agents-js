// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { beforeAll, describe, expect, it } from 'vitest';
import { APIError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { USERDATA_TTS_STARTED_TIME } from '../types.js';
import { FallbackAdapter } from './fallback_adapter.js';
import { ChunkedStream, SynthesizeStream, TTS } from './tts.js';

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
        throw new APIError('mock TTS failed after receiving input');
      }
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
    if (this.shouldFail) {
      throw new APIError('mock TTS failed immediately');
    }
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
  /** When failing, first consume a token (and mark started) before throwing. */
  failAfterInput = false;
  /** Simulated latency between receiving text and sending it to the provider. */
  sendDelayMs = 0;
  /** The started time the stream recorded when it "sent" text to the provider. */
  lastMarkedTime?: number;

  constructor(label: string, sampleRate: number = SAMPLE_RATE) {
    super(sampleRate, 1, { streaming: true });
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
});
