// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

/** Read the stream to its end, as the consumer does, and report what it saw. */
async function collect(stream: AsyncIterable<unknown>) {
  const events: Array<'audio' | 'END_OF_STREAM'> = [];
  for await (const event of stream) {
    events.push(event === SynthesizeStream.END_OF_STREAM ? 'END_OF_STREAM' : 'audio');
  }
  return events;
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  await collect(stream);
}

function errorsOf(tts: TTS) {
  const errors: Array<{ recoverable: boolean; message: string }> = [];
  tts.on('error', (e) => errors.push({ recoverable: e.recoverable, message: e.error.message }));
  return errors;
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

type ReplayItem = string | 'FLUSH';

/**
 * A provider that, like the real ones, drains `this.input` once per attempt. Each attempt's
 * script decides what happens after it has read what is available. `replay` sets the opt-in
 * `replayInputOnRetry`; a plain `SynthesizeStream` leaves it off.
 */
class ReplayStream extends SynthesizeStream {
  label = 'test.ReplayStream';
  readonly seen: ReplayItem[][] = [];
  readonly attemptStarted: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  protected override readonly replayInputOnRetry: boolean;

  constructor(
    tts: TTS,
    connOptions: APIConnectOptions,
    private readonly script: (attempt: number, stream: ReplayStream) => Promise<void>,
    replay = true,
  ) {
    super(tts, connOptions);
    this.replayInputOnRetry = replay;
    this.audioPut = new Promise((resolve) => {
      this.#resolveAudioPut = resolve;
    });
    for (let i = 0; i < 4; i++) {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.attemptStarted.push({ promise, resolve });
    }
  }

  /** Read until the queue ends; `stopAfter` leaves early once that many items were read. */
  async readInput(attempt: number, stopAfter = Infinity): Promise<void> {
    const items = this.seen[attempt]!;
    for await (const item of this.input) {
      items.push(item === SynthesizeStream.FLUSH_SENTINEL ? 'FLUSH' : item);
      if (items.length >= stopAfter) return;
    }
  }

  /** Resolves when `putAudio()` was first called. */
  readonly audioPut: Promise<void>;
  #resolveAudioPut: () => void = () => {};

  startClock(): void {
    this.markStarted();
  }

  waitForAbort(): Promise<void> {
    return new Promise((resolve) => {
      if (this.abortSignal.aborted) resolve();
      this.abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  putAudio(): void {
    this.#resolveAudioPut();
    this.queue.put({
      requestId: 'r',
      segmentId: 's',
      frame: audioFrame(7),
      final: false,
    });
  }

  closeInput(): void {
    if (!this.input.closed) this.input.close();
  }

  protected async run(): Promise<void> {
    const attempt = this.seen.length;
    this.seen.push([]);
    this.attemptStarted[attempt]?.resolve();
    await this.script(attempt, this);
  }
}

/** A stream that does not mention `replayInputOnRetry`, like every plugin on `main`. */
class PlainStream extends SynthesizeStream {
  label = 'test.PlainStream';
  readonly seen: ReplayItem[][] = [];

  protected async run(): Promise<void> {
    const items: ReplayItem[] = [];
    this.seen.push(items);
    for await (const item of this.input) {
      items.push(item === SynthesizeStream.FLUSH_SENTINEL ? 'FLUSH' : item);
    }
    if (this.seen.length === 1) throw retryable();
    this.queue.put({ requestId: 'r', segmentId: 's', frame: audioFrame(7), final: false });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The first retry always waits this long, whatever `retryIntervalMs` is (`intervalForRetry` in
 * `types.ts`). Tests that act "inside the retry delay" rely on it.
 */
const FIRST_RETRY_DELAY_MS = 100;

const retryable = () =>
  new APIConnectionError({ message: 'dropped', options: { retryable: true } });

describe('SynthesizeStream input replay on retry (replayInputOnRetry on)', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
  });

  const OPTIONS: APIConnectOptions = { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 1000 };

  it('gives the retry the same input the failed attempt consumed', async () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      if (attempt === 0) throw retryable();
      s.putAudio();
    });

    stream.pushText('Hello ');
    stream.pushText('there.');
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toEqual([
      ['Hello ', 'there.', 'FLUSH'],
      ['Hello ', 'there.', 'FLUSH'],
    ]);
  });

  it('replays to every attempt until the retries run out', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, { ...OPTIONS, maxRetry: 2 }, async (attempt, s) => {
      await s.readInput(attempt);
      throw retryable();
    });

    stream.pushText('Hi.');
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toEqual([
      ['Hi.', 'FLUSH'],
      ['Hi.', 'FLUSH'],
      ['Hi.', 'FLUSH'],
    ]);
    expect(errors.map((e) => e.recoverable)).toEqual([false]);
  });

  it('delivers text pushed after the failure once and in order', async () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      if (attempt === 0) {
        await s.readInput(attempt, 2);
        // the failure is detected a beat after the provider stops reading
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw retryable();
      }
      await s.readInput(attempt);
      s.putAudio();
    });

    stream.pushText('First. ');
    stream.pushText('Second ');
    await stream.attemptStarted[0]!.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // pushed while attempt 0 is still failing: only the replay buffer can carry it over
    stream.pushText('third ');
    await stream.attemptStarted[1]!.promise;
    // pushed while attempt 1 is running
    stream.pushText('fourth.');
    stream.endInput();
    await consume(stream);

    expect(stream.seen[0]).toEqual(['First. ', 'Second ']);
    expect(stream.seen[1]).toEqual(['First. ', 'Second ', 'third ', 'fourth.', 'FLUSH']);
  });

  it('delivers text pushed while the retry waits, once', async () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      if (attempt === 0) {
        await s.readInput(attempt, 1);
        throw retryable();
      }
      await s.readInput(attempt);
      s.putAudio();
    });

    stream.pushText('A ');
    await stream.attemptStarted[0]!.promise;
    // 20 ms is inside the 100 ms first-retry delay
    await sleep(20);
    stream.pushText('B');
    stream.endInput();
    await consume(stream);

    expect(stream.seen[1]).toEqual(['A ', 'B', 'FLUSH']);
  });

  it('ends the retry when input ends after the failure', async () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      if (attempt === 0) {
        await s.readInput(attempt, 1);
        s.closeInput(); // a provider releasing its readers on failure
        throw retryable();
      }
      await s.readInput(attempt);
      s.putAudio();
    });

    stream.pushText('Only.');
    await stream.attemptStarted[0]!.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));
    stream.endInput();
    stream.endInput(); // a second call must not add another flush or fail
    await consume(stream);

    expect(stream.seen[1]).toEqual(['Only.', 'FLUSH']);
  });

  it('replays a flush in its original place', async () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      if (attempt === 0) throw retryable();
      s.putAudio();
    });

    stream.pushText('A ');
    stream.flush();
    stream.pushText('B');
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toEqual([
      ['A ', 'FLUSH', 'B', 'FLUSH'],
      ['A ', 'FLUSH', 'B', 'FLUSH'],
    ]);
  });

  it("closes the failed attempt's queue so its waiting reader returns", async () => {
    const tts = new TestTTS();
    let released = false;
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      if (attempt === 0) {
        // a provider task that is still waiting for more text when the attempt fails
        void s.readInput(attempt).then(() => {
          released = true;
        });
        await sleep(5);
        throw retryable();
      }
      await s.readInput(attempt);
      s.putAudio();
    });

    stream.pushText('A ');
    await sleep(FIRST_RETRY_DELAY_MS / 2);
    // the retry has not started yet and the caller has not ended the input
    expect(released).toBe(true);
    stream.endInput();
    await consume(stream);

    expect(stream.seen[1]).toEqual(['A ', 'FLUSH']);
  });

  it('stops before the next attempt when the stream is closed during the retry delay', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt, 1);
      throw retryable();
    });

    stream.pushText('A ');
    await stream.attemptStarted[0]!.promise;
    await sleep(20); // inside the 100 ms first-retry delay
    stream.close();
    await consume(stream);
    await sleep(FIRST_RETRY_DELAY_MS + 50); // past the end of the delay

    expect(stream.seen).toEqual([['A ']]);
    expect(errors).toEqual([]);
  });

  it('keeps counting audio that arrives while the retry waits', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      throw retryable(); // no attempt reaches audio by itself
    });

    stream.pushText('A ');
    stream.endInput();
    await stream.attemptStarted[0]!.promise;
    await sleep(20); // inside the 100 ms first-retry delay
    stream.putAudio(); // a late frame from the failed attempt
    await consume(stream);

    // attempt 1 fails before any audio of its own; the late frame still ends the retries
    expect(stream.seen).toHaveLength(2);
    expect(errors.map((e) => e.recoverable)).toEqual([false]);
  });

  it('emits cancelled metrics when endInput follows a close', async () => {
    const tts = new TestTTS();
    const metrics: TTSMetrics[] = [];
    tts.on('metrics_collected', (m) => metrics.push(m));
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      s.startClock();
      await s.readInput(attempt, 1);
      s.putAudio();
      await s.waitForAbort();
    });

    stream.pushText('Hello');
    await stream.audioPut;
    await sleep(10); // let the metrics task read the frame
    // pumpInput calls endInput after an interrupted turn, once the stream is closed
    stream.close();
    stream.endInput();
    await consume(stream);
    // the metrics task emits after the output has closed
    await vi.waitFor(() => expect(metrics).toHaveLength(1));

    expect(metrics.map((m) => ({ cancelled: m.cancelled, chars: m.charactersCount }))).toEqual([
      { cancelled: true, chars: 5 },
    ]);
  });

  it('does not retry once audio was emitted', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      s.putAudio();
      throw retryable();
    });

    stream.pushText('Spoken.');
    stream.endInput();
    const events = [];
    for await (const event of stream) events.push(event);

    expect(stream.seen).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(errors).toEqual([{ recoverable: false, message: 'dropped' }]);
    expect(stream.error?.message).toBe('dropped');
  });

  it('still retries when an attempt only ended the stream', async () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      if (attempt === 0) {
        s['queue'].put(SynthesizeStream.END_OF_STREAM);
        throw retryable();
      }
      s.putAudio();
    });

    stream.pushText('Hi.');
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toHaveLength(2);
  });

  it('does not replay a non-retryable failure', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      throw new APIConnectionError({ message: 'fatal', options: { retryable: false } });
    });

    stream.pushText('Hi.');
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toHaveLength(1);
    expect(errors).toEqual([{ recoverable: false, message: 'fatal' }]);
  });
});

describe('SynthesizeStream turn that ends without audio (replayInputOnRetry on)', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
  });

  const OPTIONS: APIConnectOptions = { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 };

  it('retries with the text replayed, then reports one unrecoverable error', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt); // reads the text, then ends without audio
    });

    stream.pushText('Hello ');
    stream.pushText('there.');
    stream.endInput();
    const events = await collect(stream);

    const turn = ['Hello ', 'there.', 'FLUSH'];
    expect(stream.seen).toEqual([turn, turn, turn]); // maxRetry 2: three attempts
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(false);
    expect(errors[0]!.message).toMatch(/no audio frames were pushed/);
    expect(errors[0]!.message).not.toContain('Hello'); // the text can be long, so it stays out
    expect(stream.error).toBeDefined();
  });

  it('ends without error when a retry produces audio', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      if (attempt === 2) s.putAudio();
    });

    stream.pushText('Hello there.');
    stream.endInput();
    const events = await collect(stream);

    expect(stream.seen).toEqual([
      ['Hello there.', 'FLUSH'],
      ['Hello there.', 'FLUSH'],
      ['Hello there.', 'FLUSH'],
    ]);
    expect(events).toEqual(['audio']);
    expect(errors).toEqual([]);
    expect(stream.error).toBeUndefined();
  });

  it('holds back the END_OF_STREAM of a silent attempt so the consumer reads the retry', async () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      if (attempt === 1) s.putAudio();
      s['queue'].put(SynthesizeStream.END_OF_STREAM); // a provider says `done` either way
    });

    stream.pushText('Hello there.');
    stream.endInput();
    const events = await collect(stream);

    // the consumer stops at the first END_OF_STREAM, so one from attempt 0 would have ended the
    // turn before the retry ran
    expect(stream.seen).toHaveLength(2);
    expect(events).toEqual(['audio', 'END_OF_STREAM']);
  });

  it('does not count END_OF_STREAM as audio', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      s['queue'].put(SynthesizeStream.END_OF_STREAM);
    });

    stream.pushText('Hello there.');
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toHaveLength(3);
    expect(errors.map((e) => e.recoverable)).toEqual([false]);
  });

  it('emits metrics once, for the attempt that produced audio', async () => {
    const tts = new TestTTS();
    const metrics: TTSMetrics[] = [];
    tts.on('metrics_collected', (m) => metrics.push(m));
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      s.startClock();
      await s.readInput(attempt);
      if (attempt === 1) s.putAudio();
    });

    stream.pushText('Hello');
    stream.endInput();
    await consume(stream);
    await vi.waitFor(() => expect(metrics).toHaveLength(1));

    expect(metrics.map((m) => ({ chars: m.charactersCount, cancelled: m.cancelled }))).toEqual([
      { chars: 5, cancelled: false },
    ]);
  });

  it('does not raise for input that is only whitespace', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      s['queue'].put(SynthesizeStream.END_OF_STREAM);
    });

    stream.pushText('  ');
    stream.pushText('\n\t');
    stream.endInput();
    const events = await collect(stream);

    expect(stream.seen).toHaveLength(1);
    expect(events).toEqual(['END_OF_STREAM']);
    expect(errors).toEqual([]);
    expect(stream.error).toBeUndefined();
  });

  it('does not raise for input that is only flushes', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
    });

    stream.flush();
    stream.flush();
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toEqual([['FLUSH', 'FLUSH', 'FLUSH']]);
    expect(errors).toEqual([]);
    expect(stream.error).toBeUndefined();
  });

  it('does not raise when the stream is closed during the turn', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt, 1);
      await s.waitForAbort(); // an interrupted turn: the provider returns once it is closed
    });

    stream.pushText('Hello there.');
    await stream.attemptStarted[0]!.promise;
    await sleep(20);
    stream.close();
    await consume(stream);
    await sleep(FIRST_RETRY_DELAY_MS + 50); // past the time a retry would have started

    expect(stream.seen).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(stream.error).toBeUndefined();
  });

  it('does not raise for a closed stream, even with maxRetry 0', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, { ...OPTIONS, maxRetry: 0 }, async (attempt, s) => {
      await s.readInput(attempt, 1);
      await s.waitForAbort(); // an interrupted turn: the provider returns once it is closed
    });

    stream.pushText('Hello there.');
    await stream.attemptStarted[0]!.promise;
    await sleep(20);
    stream.close();
    await consume(stream);
    await sleep(50); // `close()` ends the output at once; the attempt settles after it

    // with no retries left, an error here would be emitted at once
    expect(stream.seen).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(stream.error).toBeUndefined();
  });

  it('does not raise when the stream is closed during the last attempt', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, { ...OPTIONS, maxRetry: 1 }, async (attempt, s) => {
      if (attempt === 0) {
        await s.readInput(attempt); // a silent turn: fails the guard and retries
        return;
      }
      await s.readInput(attempt, 1);
      await s.waitForAbort(); // the close lands while the last attempt is running
    });

    stream.pushText('Hello there.');
    stream.endInput();
    await stream.attemptStarted[1]!.promise;
    await sleep(20);
    stream.close();
    await consume(stream);
    await sleep(50); // `close()` ends the output at once; the attempt settles after it

    expect(stream.seen).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(stream.error).toBeUndefined();
  });

  it('reports one unrecoverable error at once with maxRetry 0', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, { ...OPTIONS, maxRetry: 0 }, async (attempt, s) => {
      await s.readInput(attempt);
    });

    stream.pushText('Hello there.');
    stream.endInput();
    const events = await collect(stream);

    expect(stream.seen).toHaveLength(1);
    expect(events).toEqual([]);
    expect(errors.map((e) => e.recoverable)).toEqual([false]);
    expect(errors[0]!.message).toMatch(/no audio frames were pushed/);
  });

  // Text a provider may turn into no audio without anything being wrong.
  it.each([
    ['a period', '.'],
    ['an ellipsis', '...'],
    ['an ellipsis character', '\u2026'],
    ['an asterisk', '*'],
    ['a quote', '"'],
    ['an emoji', '\u{1F600}'],
    ['a zero-width space', '\u200b'],
    ['mixed punctuation, emoji and zero-width text', ' ... \u2026 * " \u{1F44B} \u200b\n'],
  ])('does not raise for input that is only %s', async (_name, text) => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      s['queue'].put(SynthesizeStream.END_OF_STREAM);
    });

    stream.pushText(text);
    stream.endInput();
    const events = await collect(stream);

    expect(stream.seen).toHaveLength(1); // no retry
    expect(events).toEqual(['END_OF_STREAM']);
    expect(errors).toEqual([]);
    expect(stream.error).toBeUndefined();
  });

  it.each([
    ['a Latin letter', 'Hi.'],
    ['a digit', '42'],
    ['Japanese', '\u3053\u3093\u306b\u3061\u306f'],
    ['Arabic', '\u0645\u0631\u062d\u0628\u0627'],
  ])('raises for a silent turn with text in %s', async (_name, text) => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, { ...OPTIONS, maxRetry: 1 }, async (attempt, s) => {
      await s.readInput(attempt);
    });

    stream.pushText(text);
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toHaveLength(2);
    expect(errors.map((e) => e.recoverable)).toEqual([false]);
  });

  it('raises when speakable text follows text that is not speakable', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, { ...OPTIONS, maxRetry: 1 }, async (attempt, s) => {
      await s.readInput(attempt);
    });

    stream.pushText('...');
    stream.pushText('Done');
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toHaveLength(2);
    expect(errors.map((e) => e.recoverable)).toEqual([false]);
  });

  it('does not raise when audio went out and the attempt then ends normally', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      s.putAudio();
    });

    stream.pushText('Hello there.');
    stream.endInput();
    await consume(stream);

    expect(stream.seen).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('does not raise a second error when audio from a failed attempt arrives during the delay', async () => {
    const tts = new TestTTS();
    const errors = errorsOf(tts);
    const stream = new ReplayStream(tts, OPTIONS, async (attempt, s) => {
      await s.readInput(attempt);
      if (attempt === 0) throw retryable();
    });

    stream.pushText('A ');
    stream.endInput();
    await stream.attemptStarted[0]!.promise;
    await sleep(20); // inside the 100 ms first-retry delay
    stream.putAudio(); // a late frame; the stream-wide latch now covers the retry too
    await consume(stream);

    // attempt 1 resolves with no audio of its own, but audio already went out: no error, no retry
    expect(stream.seen).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});

describe('SynthesizeStream with replayInputOnRetry off (the default)', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
  });

  const OPTIONS: APIConnectOptions = { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 1000 };

  it('is off for a subclass that does not mention it, and the retry reads the drained queue', async () => {
    const tts = new TestTTS();
    const stream = new PlainStream(tts, OPTIONS);

    stream.pushText('Hi.');
    stream.endInput();
    await consume(stream);

    // the same behaviour as `main`: attempt 0 drained the queue, so attempt 1 reads nothing
    expect(stream.seen).toEqual([['Hi.', 'FLUSH'], []]);
  });

  it('is off unless a subclass turns it on', () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(tts, OPTIONS, async () => {}, false);
    expect(stream['replayInputOnRetry']).toBe(false);
    expect(new ReplayStream(tts, OPTIONS, async () => {})['replayInputOnRetry']).toBe(true);
    stream.close();
  });

  it('still retries after audio was emitted', async () => {
    const tts = new TestTTS();
    const errors: boolean[] = [];
    tts.on('error', (e) => errors.push(e.recoverable));
    const stream = new ReplayStream(
      tts,
      OPTIONS,
      async (attempt, s) => {
        await s.readInput(attempt);
        s.putAudio();
        if (attempt === 0) throw retryable();
      },
      false,
    );

    stream.pushText('Spoken.');
    stream.endInput();
    const events = [];
    for await (const event of stream) events.push(event);

    expect(stream.seen).toHaveLength(2);
    expect(events.filter((e) => typeof e !== 'symbol')).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(stream.error).toBeUndefined();
  });

  it('replays nothing: the retry reads the queue the failed attempt drained', async () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(
      tts,
      OPTIONS,
      async (attempt, s) => {
        await s.readInput(attempt, attempt === 0 ? 1 : Infinity);
        if (attempt === 0) throw retryable();
        s.putAudio();
      },
      false,
    );

    stream.pushText('A ');
    await stream.attemptStarted[0]!.promise;
    // 20 ms is inside the 100 ms first-retry delay
    await sleep(20);
    stream.pushText('B');
    stream.endInput();
    await consume(stream);

    // 'A ' is not replayed; only what was pushed after the failure reaches the retry
    expect(stream.seen[0]).toEqual(['A ']);
    expect(stream.seen[1]).toEqual(['B', 'FLUSH']);
  });

  it('keeps the original input guards', async () => {
    const tts = new TestTTS();
    const stream = new ReplayStream(
      tts,
      OPTIONS,
      async (attempt, s) => {
        await s.readInput(attempt);
        s.putAudio();
      },
      false,
    );

    stream.pushText('Once.');
    stream.endInput();
    stream.endInput(); // the second call finds the queue closed and does nothing
    stream.pushText('late'); // dropped: the queue is closed
    await consume(stream);

    expect(stream.seen).toEqual([['Once.', 'FLUSH']]);
  });
});

describe('SynthesizeStream turn that ends without audio (replayInputOnRetry off)', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
  });

  it('ends without error, as before', async () => {
    const tts = new TestTTS();
    const errors: unknown[] = [];
    tts.on('error', (e) => errors.push(e));
    const stream = new ReplayStream(
      tts,
      { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 1000 },
      async (attempt, s) => {
        await s.readInput(attempt);
        s['queue'].put(SynthesizeStream.END_OF_STREAM);
      },
      false,
    );

    stream.pushText('Hello there.');
    stream.endInput();
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);

    expect(stream.seen).toEqual([['Hello there.', 'FLUSH']]);
    expect(events).toEqual([SynthesizeStream.END_OF_STREAM]);
    expect(errors).toEqual([]);
    expect(stream.error).toBeUndefined();
  });
});

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
