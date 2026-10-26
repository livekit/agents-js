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
import { ChunkedStream, SynthesizeStream, TTS } from './tts.js';
import type { SynthesizedAudio } from './tts.js';

type AttemptResult = 'success' | 'retryable-error' | 'nonretryable-error' | 'pending';

class HookTTS extends TTS {
  label = 'test.HookTTS';

  constructor() {
    super(24000, 1, { streaming: true });
  }

  synthesize(
    _text: string,
    _connOptions?: APIConnectOptions,
    _abortSignal?: AbortSignal,
  ): ChunkedStream {
    throw new Error('not implemented');
  }

  stream(_options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    throw new Error('not implemented');
  }
}

class HookStream extends SynthesizeStream {
  label = 'test.HookStream';
  attempts = 0;
  doneCalls = 0;
  doneCallsAtAttempt: number[] = [];
  done: Promise<void>;
  started: Promise<void>;
  #attemptResults: AttemptResult[];
  #throwOnDone: boolean;
  #doneResolve: (() => void) | undefined;
  #startedResolve: (() => void) | undefined;

  constructor(
    tts: TTS,
    attemptResults: AttemptResult[],
    connOptions: APIConnectOptions,
    throwOnDone = false,
  ) {
    super(tts, connOptions);
    this.#attemptResults = attemptResults;
    this.#throwOnDone = throwOnDone;
    this.done = new Promise<void>((resolve) => {
      this.#doneResolve = resolve;
    });
    this.started = new Promise<void>((resolve) => {
      this.#startedResolve = resolve;
    });
  }

  protected async run(): Promise<void> {
    const result = this.#attemptResults[this.attempts] ?? 'success';
    this.doneCallsAtAttempt.push(this.doneCalls);
    this.attempts += 1;
    this.#startedResolve?.();

    if (result === 'retryable-error') {
      throw new APIConnectionError({
        message: 'retryable failure',
        options: { retryable: true },
      });
    }
    if (result === 'nonretryable-error') {
      throw new APIConnectionError({
        message: 'nonretryable failure',
        options: { retryable: false },
      });
    }
    if (result === 'pending') {
      await new Promise<void>((resolve) => {
        if (this.abortSignal.aborted) {
          resolve();
          return;
        }
        this.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }

  protected override onStreamDone(): void {
    this.doneCalls += 1;
    this.#doneResolve?.();
    if (this.#throwOnDone) throw new Error('completion hook failed');
  }
}

async function settlementByNextTurn(promise: Promise<void>): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ]);
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Consume through whole-stream output closure.
  }
}

describe('SynthesizeStream whole-stream completion', () => {
  it('runs once after immediate success', async () => {
    const stream = new HookStream(new HookTTS(), ['success'], {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 1000,
    });

    await consume(stream);
    expect(stream.attempts).toBe(1);
    expect(stream.doneCalls).toBe(1);
  });

  it('runs once after retry success and not between attempts', async () => {
    const stream = new HookStream(new HookTTS(), ['retryable-error', 'success'], {
      maxRetry: 1,
      retryIntervalMs: 0,
      timeoutMs: 1000,
    });

    await consume(stream);
    expect(stream.attempts).toBe(2);
    expect(stream.doneCallsAtAttempt).toEqual([0, 0]);
    expect(stream.doneCalls).toBe(1);
  });

  it('runs once after nonretryable failure', async () => {
    const tts = new HookTTS();
    tts.on('error', () => {});
    const stream = new HookStream(tts, ['nonretryable-error'], {
      maxRetry: 1,
      retryIntervalMs: 0,
      timeoutMs: 1000,
    });

    await consume(stream);
    expect(stream.attempts).toBe(1);
    expect(stream.doneCalls).toBe(1);
  });

  it('runs once after retries are exhausted', async () => {
    const tts = new HookTTS();
    tts.on('error', () => {});
    const stream = new HookStream(tts, ['retryable-error', 'retryable-error'], {
      maxRetry: 1,
      retryIntervalMs: 0,
      timeoutMs: 1000,
    });

    await consume(stream);
    expect(stream.attempts).toBe(2);
    expect(stream.doneCallsAtAttempt).toEqual([0, 0]);
    expect(stream.doneCalls).toBe(1);
  });

  it('runs once after explicit close without consuming output', async () => {
    const stream = new HookStream(new HookTTS(), ['pending'], {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 1000,
    });
    await stream.started;

    stream.close();

    expect(await settlementByNextTurn(stream.done)).toBe('settled');
    expect(stream.attempts).toBe(1);
    expect(stream.doneCalls).toBe(1);
  });

  it('still closes output when the completion hook throws', async () => {
    const stream = new HookStream(
      new HookTTS(),
      ['success'],
      {
        maxRetry: 0,
        retryIntervalMs: 0,
        timeoutMs: 1000,
      },
      true,
    );

    await consume(stream);

    expect(stream.doneCalls).toBe(1);
  });
});

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
