// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { APIConnectionError } from '../_exceptions.js';
import type { APIConnectOptions } from '../types.js';
import { ChunkedStream, SynthesizeStream, TTS } from './tts.js';

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
