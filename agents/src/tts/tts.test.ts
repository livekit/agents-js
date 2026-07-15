// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { beforeAll, describe, expect, it } from 'vitest';
import { APIConnectionError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import type { TTSMetrics } from '../metrics/base.js';
import type { APIConnectOptions } from '../types.js';
import { AsyncIterableQueue } from '../utils.js';
import { ChunkedStream, TTS } from './tts.js';
import type { SynthesizeStream, SynthesizedAudio } from './tts.js';

const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 80;
const RETRY_OPTIONS: APIConnectOptions = {
  maxRetry: 1,
  retryIntervalMs: 0,
  timeoutMs: 500,
};

function audioFrame(sample: number): AudioFrame {
  return new AudioFrame(new Int16Array(FRAME_SAMPLES).fill(sample), SAMPLE_RATE, 1, FRAME_SAMPLES);
}

class TestTTS extends TTS {
  label = 'test.TTS';

  constructor() {
    super(SAMPLE_RATE, 1, { streaming: false });
  }

  synthesize(): ChunkedStream {
    throw new Error('not used');
  }

  stream(): SynthesizeStream {
    throw new Error('not used');
  }
}

class RetryChunkedStream extends ChunkedStream {
  label = 'test.RetryChunkedStream';
  attempts = 0;

  protected async run(): Promise<void> {
    this.attempts++;
    const requestId = `request-${this.attempts}`;

    if (this.attempts === 1) {
      this.queue.put({
        requestId,
        segmentId: 'segment',
        frame: audioFrame(1),
        final: false,
      });
      throw new APIConnectionError({ message: 'connection dropped after partial audio' });
    }

    this.queue.put({
      requestId,
      segmentId: 'segment',
      frame: audioFrame(2),
      final: false,
    });
    this.queue.put({
      requestId,
      segmentId: 'segment',
      frame: audioFrame(3),
      final: true,
    });
  }
}

class CloseDuringPutQueue extends AsyncIterableQueue<SynthesizedAudio> {
  readonly putStarted: Promise<void>;
  closedAfterClose = false;
  private resolvePutStarted: () => void = () => {};

  constructor(private closeStream: () => void) {
    super();
    this.putStarted = new Promise((resolve) => {
      this.resolvePutStarted = resolve;
    });
  }

  override put(item: SynthesizedAudio): void {
    this.closeStream();
    this.closedAfterClose = this.closed;
    this.resolvePutStarted();
    if (!this.closed) {
      super.put(item);
    }
  }
}

class CloseRaceChunkedStream extends ChunkedStream {
  label = 'test.CloseRaceChunkedStream';
  readonly metricsPutStarted: Promise<void>;
  private readonly closeDuringPutQueue: CloseDuringPutQueue;

  constructor(tts: TTS) {
    super('close during synthesis', tts, RETRY_OPTIONS);
    this.closeDuringPutQueue = new CloseDuringPutQueue(() => this.close());
    this.output = this.closeDuringPutQueue;
    this.metricsPutStarted = this.closeDuringPutQueue.putStarted;
  }

  get outputClosedDuringMetricsPut(): boolean {
    return this.closeDuringPutQueue.closedAfterClose;
  }

  protected async run(): Promise<void> {
    this.queue.put({
      requestId: 'closing-request',
      segmentId: 'segment',
      frame: audioFrame(4),
      final: false,
    });
  }
}

describe('ChunkedStream', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
  });

  it('retries partial audio with a fresh non-interleaved request ID', async () => {
    const tts = new TestTTS();
    const stream = new RetryChunkedStream('retry synthesis', tts, RETRY_OPTIONS);
    const metrics: TTSMetrics[] = [];
    const metricsCollected = new Promise<void>((resolve) => {
      tts.on('metrics_collected', (event) => {
        metrics.push(event);
        resolve();
      });
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    await metricsCollected;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stream.attempts).toBe(2);
    expect(events.map((event) => event.requestId)).toEqual(['request-1', 'request-2', 'request-2']);
    expect(events.map((event) => event.frame.data[0])).toEqual([1, 2, 3]);
    expect(
      events.filter((event) => event.requestId === 'request-2').map((event) => event.final),
    ).toEqual([false, true]);
    expect(metrics).toHaveLength(1);
  });

  it('keeps output open when closing after metrics dequeues buffered audio', async () => {
    const tts = new TestTTS();
    const stream = new CloseRaceChunkedStream(tts);
    const metricsCollected = new Promise<void>((resolve) => {
      tts.once('metrics_collected', () => resolve());
    });

    await stream.metricsPutStarted;

    expect(stream.outputClosedDuringMetricsPut).toBe(false);
    await metricsCollected;
  });
});
