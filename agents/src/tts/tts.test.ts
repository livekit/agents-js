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
import type { SynthesizedAudio, TTSError } from './tts.js';

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

class RetrySynthesizeStream extends SynthesizeStream {
  label = 'test.RetrySynthesizeStream';
  attempts: Array<Array<string | '<flush>'>> = [];

  constructor(
    tts: TTS,
    connOptions: APIConnectOptions,
    private readonly emitAudioBeforeFailure = false,
  ) {
    super(tts, connOptions);
  }

  protected async run(): Promise<void> {
    const input: Array<string | '<flush>'> = [];
    for await (const item of this.input) {
      input.push(typeof item === 'string' ? item : '<flush>');
    }
    this.attempts.push(input);

    if (this.attempts.length === 1) {
      if (this.emitAudioBeforeFailure) {
        this.queue.put({
          requestId: 'request-1',
          segmentId: 'segment',
          frame: audioFrame(1),
          final: false,
        });
      }
      throw new APIConnectionError({
        message: 'connection dropped after consuming input',
        options: { retryable: true },
      });
    }
  }
}

class MidInputRetrySynthesizeStream extends SynthesizeStream {
  label = 'test.MidInputRetrySynthesizeStream';
  attempts: Array<Array<string | '<flush>'>> = [];
  firstInputConsumed: Promise<void>;
  #resolveFirstInputConsumed!: () => void;

  constructor(tts: TTS, connOptions: APIConnectOptions) {
    super(tts, connOptions);
    this.firstInputConsumed = new Promise((resolve) => {
      this.#resolveFirstInputConsumed = resolve;
    });
  }

  protected async run(): Promise<void> {
    const attempt: Array<string | '<flush>'> = [];
    this.attempts.push(attempt);

    for await (const item of this.input) {
      attempt.push(typeof item === 'string' ? item : '<flush>');
      if (this.attempts.length === 1) {
        this.#resolveFirstInputConsumed();
        throw new APIConnectionError({ message: 'connection dropped while input was open' });
      }
    }
  }
}

type InputRetryMode = 'replay' | 'stream' | 'resume';

/** Fails its first attempt as scripted, then turns each input item into one audio frame. */
class ModeRetrySynthesizeStream extends SynthesizeStream {
  label = 'test.ModeRetrySynthesizeStream';
  protected override readonly inputRetryMode: InputRetryMode;
  attempts: Array<Array<string | '<flush>'>> = [];
  firstFailed: Promise<void>;
  #resolveFirstFailed!: () => void;

  constructor(
    tts: TTS,
    connOptions: APIConnectOptions,
    mode: InputRetryMode,
    private readonly firstAttempt: { audioBeforeFailure: boolean; failAfterItems: number },
  ) {
    super(tts, connOptions);
    this.inputRetryMode = mode;
    this.firstFailed = new Promise((resolve) => {
      this.#resolveFirstFailed = resolve;
    });
  }

  protected async run(): Promise<void> {
    // Like the Rime pump, read whatever `input` currently is for every item.
    const attempt: Array<string | '<flush>'> = [];
    this.attempts.push(attempt);
    const first = this.attempts.length === 1;
    if (first && this.firstAttempt.audioBeforeFailure) this.#emit('pre-failure audio');

    for (;;) {
      if (first && attempt.length === this.firstAttempt.failAfterItems) {
        this.#resolveFirstFailed();
        throw new APIConnectionError({ message: 'retryable failure' });
      }
      const item = await this.input.next();
      if (item.done) break;
      attempt.push(typeof item.value === 'string' ? item.value : '<flush>');
      if (!first && typeof item.value === 'string') this.#emit(item.value);
    }
    this.queue.put(SynthesizeStream.END_OF_STREAM);
  }

  #emit(segmentId: string) {
    this.queue.put({ requestId: 'request', segmentId, frame: audioFrame(1), final: false });
  }
}

/** Throws a retryable error when the stream is closed, like a provider whose socket was torn down. */
class FailOnCloseSynthesizeStream extends SynthesizeStream {
  label = 'test.FailOnCloseSynthesizeStream';
  attempts = 0;
  started: Promise<void>;
  #resolveStarted!: () => void;

  constructor(tts: TTS, connOptions: APIConnectOptions) {
    super(tts, connOptions);
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  protected async run(): Promise<void> {
    this.attempts += 1;
    this.#resolveStarted();
    if (!this.abortSignal.aborted) {
      await new Promise((resolve) =>
        this.abortSignal.addEventListener('abort', resolve, { once: true }),
      );
    }
    throw new APIConnectionError({ message: 'socket closed' });
  }
}

async function collectSegments(stream: SynthesizeStream): Promise<string[]> {
  const segments: string[] = [];
  for await (const event of stream) {
    if (event !== SynthesizeStream.END_OF_STREAM) segments.push(event.segmentId);
  }
  return segments;
}

describe('SynthesizeStream retries', () => {
  it('returns audio from the retry, including text pushed during the retry delay', async () => {
    const tts = new TestTTS();
    const errors: TTSError[] = [];
    tts.on('error', (error) => errors.push(error));
    const stream = new ModeRetrySynthesizeStream(
      tts,
      { ...RETRY_OPTIONS, retryIntervalMs: 50 },
      'replay',
      { audioBeforeFailure: false, failAfterItems: 2 },
    );
    const output = collectSegments(stream);
    stream.pushText('hello');
    stream.flush();

    await stream.firstFailed;
    stream.pushText('world');
    stream.endInput();

    expect(await output).toEqual(['hello', 'world']);
    expect(stream.attempts).toEqual([
      ['hello', '<flush>'],
      ['hello', '<flush>', 'world', '<flush>'],
    ]);
    expect(errors).toEqual([]);
  });

  it('does not retry or report an attempt that fails because the stream closed', async () => {
    const tts = new TestTTS();
    const errors: TTSError[] = [];
    tts.on('error', (error) => errors.push(error));
    const stream = new FailOnCloseSynthesizeStream(tts, { ...RETRY_OPTIONS, maxRetry: 2 });
    stream.pushText('hello');

    await stream.started;
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(stream.attempts).toBe(1);
    expect(errors).toEqual([]);
  });

  it('does not start a retry when the stream closes during the retry delay', async () => {
    const tts = new TestTTS();
    const errors: TTSError[] = [];
    tts.on('error', (error) => errors.push(error));
    const stream = new MidInputRetrySynthesizeStream(tts, {
      ...RETRY_OPTIONS,
      retryIntervalMs: 50,
    });
    stream.pushText('hello');

    await stream.firstInputConsumed;
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(stream.attempts).toEqual([['hello']]);
    expect(errors).toEqual([]);
  });

  it.each([
    ['stream', false],
    ['resume', true],
  ] as const)(
    'leaves input to a %s-mode subclass; retries after audio: %s',
    async (mode, retriesAfterAudio) => {
      const stream = new ModeRetrySynthesizeStream(new TestTTS(), RETRY_OPTIONS, mode, {
        audioBeforeFailure: true,
        failAfterItems: 1,
      });
      const output = collectSegments(stream);
      stream.pushText('hello');
      stream.pushText('world');
      stream.endInput();

      const segments = await output;
      if (retriesAfterAudio) {
        // The subclass resumes with the input it has not read yet.
        expect(stream.attempts).toEqual([['hello'], ['world', '<flush>']]);
        expect(segments).toEqual(['pre-failure audio', 'world']);
      } else {
        expect(stream.attempts).toEqual([['hello']]);
        expect(segments).toEqual(['pre-failure audio']);
      }
    },
  );

  it('retries a stream-mode subclass before audio without replacing its input', async () => {
    const stream = new ModeRetrySynthesizeStream(new TestTTS(), RETRY_OPTIONS, 'stream', {
      audioBeforeFailure: false,
      failAfterItems: 1,
    });
    const output = collectSegments(stream);
    stream.pushText('hello');
    stream.pushText('world');
    stream.endInput();

    expect(await output).toEqual(['world']);
    expect(stream.attempts).toEqual([['hello'], ['world', '<flush>']]);
  });

  it('replays buffered input into a fresh queue', async () => {
    const stream = new RetrySynthesizeStream(new TestTTS(), RETRY_OPTIONS);
    stream.pushText('hello');
    stream.flush();
    stream.pushText('world');
    stream.endInput();

    await consume(stream);

    expect(stream.attempts).toEqual([
      ['hello', '<flush>', 'world', '<flush>'],
      ['hello', '<flush>', 'world', '<flush>'],
    ]);
  });

  it('keeps accepting input while a failed attempt is replaced', async () => {
    const stream = new MidInputRetrySynthesizeStream(new TestTTS(), RETRY_OPTIONS);
    const outputTask = consume(stream);
    stream.pushText('hello');

    await stream.firstInputConsumed;
    stream.pushText('world');
    stream.endInput();
    await outputTask;

    expect(stream.attempts).toEqual([['hello'], ['hello', 'world', '<flush>']]);
  });

  it('does not retry after emitting partial audio', async () => {
    const tts = new TestTTS();
    const errors: TTSError[] = [];
    tts.on('error', (error) => errors.push(error));
    const stream = new RetrySynthesizeStream(tts, RETRY_OPTIONS, true);
    stream.pushText('hello');
    stream.endInput();

    await consume(stream);

    expect(stream.attempts).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.recoverable).toBe(false);
  });
});

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
