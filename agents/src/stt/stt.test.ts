// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { APIConnectionError, APIStatusError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { type AudioBuffer, delay } from '../utils.js';
import { STT, type SpeechEvent, SpeechEventType, SpeechStream } from './stt.js';

/**
 * Emits one final transcript per attempt, then closes the socket the way a provider with a
 * fixed session cap does (Gemini Live sends a GoAway roughly every 10 minutes).
 */
class DurationCapSTT extends STT {
  label = 'duration-cap-stt';

  constructor(private readonly failuresBeforeIdle: number) {
    super({ streaming: true, interimResults: false });
  }

  protected async _recognize(_buffer: AudioBuffer): Promise<SpeechEvent> {
    throw new APIConnectionError({ message: 'not used' });
  }

  override stream(options?: { connOptions?: APIConnectOptions }): DurationCapStream {
    return new DurationCapStream(this, this.failuresBeforeIdle, options?.connOptions);
  }
}

class DurationCapStream extends SpeechStream {
  label = 'duration-cap-stream';
  runCount = 0;

  constructor(
    stt: STT,
    private readonly failuresBeforeIdle: number,
    connOptions?: APIConnectOptions,
  ) {
    super(stt, undefined, connOptions);
  }

  protected async run(): Promise<void> {
    this.runCount += 1;

    if (this.runCount > this.failuresBeforeIdle) {
      for await (const _ of this.input) {
        /* drain */
      }
      return;
    }

    this.queue.put({
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text: `turn ${this.runCount}`, startTime: 0, endTime: 0, confidence: 1 }],
    });

    // Let monitorMetrics() drain the queue so the successful turn is observed before the
    // socket drops, matching the ordering a real provider produces.
    await delay(5);

    throw new APIStatusError({
      message: 'GoAway: session duration limit reached',
      options: { statusCode: 1008, body: null, retryable: true },
    });
  }
}

class AlwaysFailingSTT extends STT {
  label = 'always-failing-stt';

  constructor() {
    super({ streaming: true, interimResults: false });
  }

  protected async _recognize(_buffer: AudioBuffer): Promise<SpeechEvent> {
    throw new APIConnectionError({ message: 'not used' });
  }

  override stream(options?: { connOptions?: APIConnectOptions }): AlwaysFailingStream {
    return new AlwaysFailingStream(this, options?.connOptions);
  }
}

class AlwaysFailingStream extends SpeechStream {
  label = 'always-failing-stream';
  runCount = 0;

  constructor(stt: STT, connOptions?: APIConnectOptions) {
    super(stt, undefined, connOptions);
  }

  protected async run(): Promise<void> {
    this.runCount += 1;
    await delay(1);
    throw new APIStatusError({
      message: 'still down',
      options: { statusCode: 503, body: null, retryable: true },
    });
  }
}

/**
 * Connects, stays up past the connect timeout without ever hearing speech, then drops — the
 * shape of Cartesia's `1001 Idle timeout` on a muted or silent caller.
 */
class IdleDropSTT extends STT {
  label = 'idle-drop-stt';

  constructor(
    private readonly drops: number,
    private readonly uptimeMs: number,
  ) {
    super({ streaming: true, interimResults: false });
  }

  protected async _recognize(_buffer: AudioBuffer): Promise<SpeechEvent> {
    throw new APIConnectionError({ message: 'not used' });
  }

  override stream(options?: { connOptions?: APIConnectOptions }): IdleDropStream {
    return new IdleDropStream(this, this.drops, this.uptimeMs, options?.connOptions);
  }
}

class IdleDropStream extends SpeechStream {
  label = 'idle-drop-stream';
  runCount = 0;

  constructor(
    stt: STT,
    private readonly drops: number,
    private readonly uptimeMs: number,
    connOptions?: APIConnectOptions,
  ) {
    super(stt, undefined, connOptions);
  }

  protected async run(): Promise<void> {
    this.runCount += 1;
    await delay(this.uptimeMs);
    if (this.runCount > this.drops) {
      for await (const _ of this.input) {
        /* drain */
      }
      return;
    }
    throw new APIConnectionError({
      message: 'connection closed unexpectedly (code=1001)',
      options: { retryable: true },
    });
  }
}

const connOptions: APIConnectOptions = { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 10_000 };

describe('SpeechStream retry budget', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    process.on('unhandledRejection', () => {});
  });

  it('reconnects past maxRetry when each attempt produced a final transcript', async () => {
    // 8 session drops with maxRetry: 3 — a lifetime counter would give up after 4 attempts.
    const stream = new DurationCapSTT(8).stream({ connOptions });

    const texts: string[] = [];
    for await (const event of stream) {
      if (event.type === SpeechEventType.FINAL_TRANSCRIPT) {
        texts.push(event.alternatives![0].text);
        if (texts.length === 8) break;
      }
    }

    expect(texts).toEqual([
      'turn 1',
      'turn 2',
      'turn 3',
      'turn 4',
      'turn 5',
      'turn 6',
      'turn 7',
      'turn 8',
    ]);
    expect(stream.runCount).toBe(8);

    await stream.close();
  });

  it('resets after an attempt that outlived the connect timeout, without any transcript', async () => {
    const stt = new IdleDropSTT(8, 30);
    const stream = stt.stream({ connOptions: { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 10 } });

    const errors: { error: Error; recoverable: boolean }[] = [];
    stt.on('error', (ev) => errors.push({ error: ev.error, recoverable: ev.recoverable }));

    while (stream.runCount < 9) {
      await delay(5);
    }

    expect(errors).toEqual([]);
    await stream.close();
  });

  it('still gives up after maxRetry consecutive failures with no transcript', async () => {
    const stt = new AlwaysFailingSTT();
    const stream = stt.stream({ connOptions });

    const errors: { error: Error; recoverable: boolean }[] = [];
    stt.on('error', (ev) => errors.push({ error: ev.error, recoverable: ev.recoverable }));

    for await (const _ of stream) {
      /* the stream ends once the retry budget is exhausted */
    }

    expect(stream.runCount).toBe(connOptions.maxRetry + 1);
    expect(errors.at(-1)!.error).toBeInstanceOf(APIStatusError);
    expect(errors.at(-1)!.recoverable).toBe(false);
    expect(stream.terminalError).toBeInstanceOf(APIConnectionError);

    await stream.close();
  });
});
