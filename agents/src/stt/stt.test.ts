// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIStatusError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { type AudioBuffer, delay } from '../utils.js';
import { STT, type SpeechEvent, SpeechEventType, SpeechStream } from './stt.js';

/**
 * Emits one final transcript per attempt, then closes the socket the way a provider with a
 * fixed session cap does (Gemini Live sends a GoAway roughly every 10 minutes).
 */
class FlappingSTT extends STT {
  label = 'flapping-stt';

  constructor(
    private readonly uptimeMs: number,
    private readonly drops: number,
    private readonly emitTranscript: (runCount: number) => boolean,
    private readonly reportProgress = false,
    private readonly eventType?: SpeechEventType,
  ) {
    super({ streaming: true, interimResults: false });
  }

  protected async _recognize(_buffer: AudioBuffer): Promise<SpeechEvent> {
    throw new APIConnectionError({ message: 'not used' });
  }

  override stream(options?: { connOptions?: APIConnectOptions }): FlappingStream {
    return new FlappingStream(
      this,
      this.uptimeMs,
      this.drops,
      this.emitTranscript,
      this.reportProgress,
      this.eventType,
      options?.connOptions,
    );
  }
}

class FlappingStream extends SpeechStream {
  label = 'flapping-stream';
  runCount = 0;

  constructor(
    stt: STT,
    private readonly uptimeMs: number,
    private readonly drops: number,
    private readonly emitTranscript: (runCount: number) => boolean,
    private readonly reportProgress: boolean,
    private readonly eventType?: SpeechEventType,
    connOptions?: APIConnectOptions,
  ) {
    super(stt, undefined, connOptions);
  }

  protected async run(): Promise<void> {
    this.runCount += 1;

    if (this.reportProgress) {
      this.markProviderProgress();
    }

    if (this.eventType !== undefined) {
      this.queue.put({
        type: this.eventType,
        recognitionUsage:
          this.eventType === SpeechEventType.RECOGNITION_USAGE ? { audioDuration: 1 } : undefined,
      });
    }

    if (this.emitTranscript(this.runCount)) {
      this.queue.put({
        type: SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [{ text: `turn ${this.runCount}`, startTime: 0, endTime: 0, confidence: 1 }],
      });
    }

    await delay(this.uptimeMs);

    if (this.runCount <= this.drops) {
      throw new APIConnectionError({ message: 'socket dropped' });
    }
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

class UntimestampedSTT extends STT {
  label = 'untimestamped-stt';

  constructor() {
    super({ streaming: true, interimResults: false });
  }

  protected async _recognize(_frame: AudioBuffer): Promise<SpeechEvent> {
    return { type: SpeechEventType.FINAL_TRANSCRIPT };
  }

  stream(): SpeechStream {
    return new UntimestampedSpeechStream(this);
  }
}

class UntimestampedSpeechStream extends SpeechStream {
  label = 'untimestamped-speech-stream';

  protected async run(): Promise<void> {
    this.queue.put({ type: SpeechEventType.START_OF_SPEECH });
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

const connOptions: APIConnectOptions = { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 10_000 };

describe('SpeechStream retry budget', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false });
    process.on('unhandledRejection', () => {});
  });

  it.each([1_000, 6_000, 180_000])(
    'keeps a finite retry budget without recognition progress at %ims uptime',
    async (uptimeMs) => {
      vi.useFakeTimers();
      const stt = new FlappingSTT(uptimeMs, 100, () => false);
      stt.on('error', () => {});
      const stream = stt.stream({ connOptions });
      try {
        await vi.runAllTimersAsync();
        for await (const _ of stream) {
          /* drain */
        }
        expect(stream.runCount).toBe(connOptions.maxRetry + 1);
        expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
      } finally {
        stream.close();
        vi.useRealTimers();
      }
    },
  );

  it('resets the retry budget after successful recognition', async () => {
    vi.useFakeTimers();
    const drops = connOptions.maxRetry * 3;
    const stream = new FlappingSTT(6_000, drops, () => true).stream({ connOptions });
    try {
      await vi.runAllTimersAsync();
      for await (const _ of stream) {
        /* drain */
      }
      expect(stream.runCount).toBe(drops + 1);
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('keeps a finite recovery budget after previously useful connections', async () => {
    vi.useFakeTimers();
    const usefulRuns = connOptions.maxRetry * 2;
    const stt = new FlappingSTT(6_000, 100, (run) => run <= usefulRuns);
    stt.on('error', () => {});
    const stream = stt.stream({ connOptions });
    try {
      await vi.runAllTimersAsync();
      for await (const _ of stream) {
        /* drain */
      }
      expect(stream.runCount).toBe(usefulRuns + connOptions.maxRetry);
      expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('resets the retry budget on provider progress without a transcript', async () => {
    vi.useFakeTimers();
    const drops = connOptions.maxRetry * 3;
    const stream = new FlappingSTT(6_000, drops, () => false, true).stream({ connOptions });
    try {
      await vi.runAllTimersAsync();
      for await (const _ of stream) {
        /* drain */
      }
      expect(stream.runCount).toBe(drops + 1);
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it.each([
    SpeechEventType.START_OF_SPEECH,
    SpeechEventType.END_OF_SPEECH,
    SpeechEventType.RECOGNITION_USAGE,
  ])('does not reset the retry budget for local event type %s', async (eventType) => {
    vi.useFakeTimers();
    const stream = new FlappingSTT(6_000, 100, () => false, false, eventType).stream({
      connOptions,
    });
    (stream as unknown as { _numRetries: number })._numRetries = 2;
    try {
      await vi.runAllTimersAsync();
      for await (const _ of stream) {
        /* drain */
      }
      expect(stream.runCount).toBe(2);
    } finally {
      stream.close();
      vi.useRealTimers();
    }
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

describe('STT event timestamps', () => {
  it('timestamps non-streaming recognition results', async () => {
    const before = Date.now();
    const event = await new UntimestampedSTT().recognize([]);

    expect(event.createdAt).toBeGreaterThanOrEqual(before);
    expect(event.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('timestamps events before a speech stream delivers them', async () => {
    const stream = new UntimestampedSTT().stream();
    const before = Date.now();

    try {
      const { value } = await stream.next();

      expect(value?.createdAt).toBeGreaterThanOrEqual(before);
      expect(value?.createdAt).toBeLessThanOrEqual(Date.now());
    } finally {
      stream.close();
    }
  });
});
