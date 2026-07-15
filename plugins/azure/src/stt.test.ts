// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STT, SpeechStream, speechsdk } from './stt.js';

const azureHarness = vi.hoisted(() => ({
  activeReaders: 0,
  cancellationErrors: 0,
  deadStreamWrites: 0,
  maxActiveReaders: 0,
  recognizers: [] as Array<{
    canceled?: (_sender: unknown, event: unknown) => void;
    sessionStarted?: (_sender: unknown, event: unknown) => void;
    sessionStopped?: (_sender: unknown, event: unknown) => void;
  }>,
  streams: [] as Array<{
    closed: boolean;
    frames: number[];
  }>,
}));

vi.mock('microsoft-cognitiveservices-speech-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('microsoft-cognitiveservices-speech-sdk')>();

  class FakePushStream {
    closed = false;
    frames: number[] = [];

    write(buffer: ArrayBuffer): void {
      if (this.closed) {
        azureHarness.deadStreamWrites += 1;
        return;
      }
      this.frames.push(new Int16Array(buffer)[0] ?? 0);
      if (azureHarness.streams[0] === this && this.frames.length === 1) {
        queueMicrotask(() => {
          azureHarness.cancellationErrors += 1;
          azureHarness.recognizers[0]?.canceled?.(undefined, {
            reason: actual.CancellationReason.Error,
            errorCode: actual.CancellationErrorCode.ServiceTimeout,
            errorDetails: 'timeout',
          });
        });
      }
    }

    close(): void {
      this.closed = true;
      const index = azureHarness.streams.indexOf(this);
      queueMicrotask(() => {
        azureHarness.recognizers[index]?.sessionStopped?.(undefined, {});
      });
    }
  }

  class FakeRecognizer {
    recognizing?: (_sender: unknown, event: unknown) => void;
    recognized?: (_sender: unknown, event: unknown) => void;
    speechStartDetected?: (_sender: unknown, event: unknown) => void;
    speechEndDetected?: (_sender: unknown, event: unknown) => void;
    sessionStarted?: (_sender: unknown, event: unknown) => void;
    sessionStopped?: (_sender: unknown, event: unknown) => void;
    canceled?: (_sender: unknown, event: unknown) => void;

    constructor() {
      azureHarness.recognizers.push(this);
    }

    startContinuousRecognitionAsync(resolve: () => void): void {
      resolve();
      queueMicrotask(() => this.sessionStarted?.(undefined, {}));
    }

    stopContinuousRecognitionAsync(resolve: () => void): void {
      resolve();
    }

    close(): void {}
  }

  return {
    ...actual,
    AudioConfig: {
      ...actual.AudioConfig,
      fromStreamInput: () => ({}),
    },
    AudioInputStream: {
      ...actual.AudioInputStream,
      createPushStream: () => {
        const stream = new FakePushStream();
        azureHarness.streams.push(stream);
        return stream;
      },
    },
    SpeechRecognizer: FakeRecognizer,
  };
});

function canceledEvent(
  reason: speechsdk.CancellationReason,
  errorCode?: speechsdk.CancellationErrorCode,
  errorDetails = '',
) {
  return { reason, errorCode, errorDetails };
}

describe('Azure STT cancellation handling', () => {
  beforeEach(() => {
    azureHarness.activeReaders = 0;
    azureHarness.cancellationErrors = 0;
    azureHarness.deadStreamWrites = 0;
    azureHarness.maxActiveReaders = 0;
    azureHarness.recognizers.length = 0;
    azureHarness.streams.length = 0;
  });

  it('unblocks run on canceled error', () => {
    const stream = SpeechStream.prototype as SpeechStream;
    const testStream = Object.create(stream) as SpeechStream;
    testStream._sessionStoppedEvent = {
      isSet: false,
      set() {
        this.isSet = true;
      },
      clear() {
        this.isSet = false;
      },
      wait: () => Promise.resolve(),
    } as SpeechStream['_sessionStoppedEvent'];
    testStream._cancellationError = null;

    const event = canceledEvent(
      speechsdk.CancellationReason.Error,
      speechsdk.CancellationErrorCode.ServiceTimeout,
      'timeout',
    );
    testStream._onCanceled(event);

    expect(testStream._sessionStoppedEvent.isSet).toBe(true);
    expect(testStream._cancellationError).toBe(event);
  });

  it('ignores cancellations without error', () => {
    const stream = SpeechStream.prototype as SpeechStream;
    const testStream = Object.create(stream) as SpeechStream;
    testStream._sessionStoppedEvent = {
      isSet: false,
      set() {
        this.isSet = true;
      },
      clear() {
        this.isSet = false;
      },
      wait: () => Promise.resolve(),
    } as SpeechStream['_sessionStoppedEvent'];
    testStream._cancellationError = null;

    testStream._onCanceled(canceledEvent(speechsdk.CancellationReason.EndOfStream));

    expect(testStream._sessionStoppedEvent.isSet).toBe(false);
    expect(testStream._cancellationError).toBeNull();
  });

  it('replaces a canceled recognizer without leaving its input consumer alive', async () => {
    const stt = new STT({ speechHost: 'wss://azure.test' });
    const stream = stt.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    const internal = stream as unknown as {
      input: {
        next(options?: { signal?: AbortSignal }): Promise<IteratorResult<AudioFrame | symbol>>;
      };
    };
    const originalNext = internal.input.next.bind(internal.input);
    internal.input.next = async (options = {}) => {
      azureHarness.activeReaders += 1;
      azureHarness.maxActiveReaders = Math.max(
        azureHarness.maxActiveReaders,
        azureHarness.activeReaders,
      );
      try {
        return await originalNext(options);
      } finally {
        azureHarness.activeReaders -= 1;
      }
    };

    stream.pushFrame(frame(1));
    await vi.waitFor(() => expect(azureHarness.recognizers).toHaveLength(2));
    stream.pushFrame(frame(2));
    stream.pushFrame(frame(3));
    await vi.waitFor(() => expect(azureHarness.streams[1]?.frames).toEqual([2, 3]));

    expect(azureHarness.cancellationErrors).toBe(1);
    expect(azureHarness.maxActiveReaders).toBe(1);
    expect(azureHarness.streams[0]?.closed).toBe(true);
    expect(azureHarness.deadStreamWrites).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(azureHarness.recognizers).toHaveLength(2);

    stream.close();
  });
});

function frame(value: number): AudioFrame {
  return new AudioFrame(new Int16Array([value]), 16000, 1, 1);
}
