// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the STT streaming retry budget.
 *
 * Previously SpeechStream.mainTask used a local loop counter that never reset, so every
 * failure over the lifetime of a stream counted toward maxRetry forever. A long-lived stream
 * that succeeded, dropped, and reconnected would eventually exhaust its budget and fail the
 * session. The fix mirrors the Python `RecognizeStream`: keep a persistent `_numRetries` and
 * reset it to 0 on every successful FINAL_TRANSCRIPT.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { APIError } from '../_exceptions.js';
import { asLanguageCode } from '../language.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { delay } from '../utils.js';
import {
  STT,
  type STTCapabilities,
  type SpeechEvent,
  SpeechEventType,
  SpeechStream,
} from './stt.js';

class RetryTestSTT extends STT {
  label = 'retry-test-stt';
  constructor(caps?: Partial<STTCapabilities>) {
    super({
      streaming: caps?.streaming ?? true,
      interimResults: caps?.interimResults ?? false,
      diarization: false,
      alignedTranscript: false,
    });
  }
  protected async _recognize(): Promise<SpeechEvent> {
    throw new Error('not used');
  }
}

/**
 * A stream whose `run()` always throws a retryable APIError, but emits a FINAL_TRANSCRIPT
 * (and waits long enough for it to be consumed, resetting the retry budget) for the first
 * `emitForRuns` runs. After that it stops emitting, so the budget can finally be exhausted.
 */
class RetryTestStream extends SpeechStream {
  runCount = 0;
  constructor(
    stt: STT,
    private readonly emitForRuns: number,
    connOptions?: APIConnectOptions,
  ) {
    super(stt, undefined, connOptions);
  }

  protected async run(): Promise<void> {
    this.runCount += 1;
    if (this.runCount <= this.emitForRuns) {
      this.queue.put({
        type: SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          { text: 'ok', language: asLanguageCode(''), startTime: 0, endTime: 0, confidence: 1 },
        ],
      });
      // Let monitorMetrics drain the queue and reset the retry counter before we throw.
      await delay(30);
    }
    throw new APIError('boom', { retryable: true });
  }
}

/** Consume the output stream to completion so we know mainTask has given up. */
async function drainToEnd(stream: SpeechStream): Promise<void> {
  for await (const _ of stream) {
    /* noop */
  }
}

describe('SpeechStream retry budget', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    process.on('unhandledRejection', () => {});
  });

  const connOptions: APIConnectOptions = { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 10_000 };

  it('gives up after maxRetry+1 attempts when no transcript is ever produced', async () => {
    const stt = new RetryTestSTT();
    const stream = new RetryTestStream(stt, /* emitForRuns */ 0, connOptions);
    await drainToEnd(stream);
    // maxRetry=3 → attempts at numRetries 0,1,2,3 then APIConnectionError on the 4th.
    expect(stream.runCount).toBe(4);
  });

  it('replenishes the retry budget after a successful FINAL_TRANSCRIPT', async () => {
    const stt = new RetryTestSTT();
    const emitForRuns = 5;
    const stream = new RetryTestStream(stt, emitForRuns, connOptions);
    await drainToEnd(stream);
    // Each of the first 5 runs resets the counter to 0 (then +1), so the stream survives well
    // past maxRetry+1=4; only once transcripts stop does it exhaust (5 + 3 more failing runs).
    expect(stream.runCount).toBeGreaterThan(4);
    expect(stream.runCount).toBe(emitForRuns + 3);
  });
});
