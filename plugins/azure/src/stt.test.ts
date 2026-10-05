// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIError, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STT, SpeechStream, speechsdk } from './stt.js';

const azureHarness = vi.hoisted(() => ({
  activeReaders: 0,
  cancellationErrors: 0,
  deadStreamWrites: 0,
  maxActiveReaders: 0,
  startupFailure: undefined as 'callback' | 'throw' | undefined,
  closedRecognizers: 0,
  recognizers: [] as Array<{
    canceled?: (_sender: unknown, event: unknown) => void;
    sessionStarted?: (_sender: unknown, event: unknown) => void;
    sessionStopped?: (_sender: unknown, event: unknown) => void;
    speechStartDetected?: (_sender: unknown, event: unknown) => void;
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

    startContinuousRecognitionAsync(resolve: () => void, reject: (error: string) => void): void {
      if (azureHarness.startupFailure === 'callback') {
        reject('connection failed');
        return;
      }
      if (azureHarness.startupFailure === 'throw') throw new TypeError('invalid SDK configuration');
      resolve();
      queueMicrotask(() => {
        this.sessionStarted?.(undefined, {});
        this.speechStartDetected?.(undefined, {});
      });
    }

    stopContinuousRecognitionAsync(resolve: () => void): void {
      resolve();
    }

    close(): void {
      azureHarness.closedRecognizers++;
    }
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
    azureHarness.startupFailure = undefined;
    azureHarness.closedRecognizers = 0;
    azureHarness.recognizers.length = 0;
    azureHarness.streams.length = 0;
  });

  it.each(['callback', 'throw'] as const)('cleans up a startup %s failure', async (failure) => {
    azureHarness.startupFailure = failure;
    const provider = new STT({ speechKey: 'test', speechRegion: 'test' });
    const onError = vi.fn();
    provider.on('error', onError);
    const stream = provider.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    try {
      for await (const _ of stream) {
        /* drain */
      }
      expect(onError).toHaveBeenCalledOnce();
      if (failure === 'callback') expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
      else {
        expect(stream.terminalError).toBeInstanceOf(TypeError);
        expect(stream.terminalError).not.toBeInstanceOf(APIError);
      }
      expect(azureHarness.closedRecognizers).toBe(1);
      expect(azureHarness.streams[0]?.closed).toBe(true);
    } finally {
      stream.close();
    }
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

  it('emits speech start after replacing a canceled recognizer mid-speech', async () => {
    const azureStt = new STT({ speechHost: 'wss://azure.test' });
    const stream = azureStt.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    const startEvents: stt.SpeechEventType[] = [];
    const collectEvents = (async () => {
      for await (const event of stream) {
        if (event.type === stt.SpeechEventType.START_OF_SPEECH) {
          startEvents.push(event.type);
        }
      }
    })();

    try {
      await vi.waitFor(() => expect(startEvents).toEqual([stt.SpeechEventType.START_OF_SPEECH]));
      stream.pushFrame(frame(1));
      await vi.waitFor(() => expect(azureHarness.recognizers).toHaveLength(2));

      await vi.waitFor(() =>
        expect(startEvents).toEqual([
          stt.SpeechEventType.START_OF_SPEECH,
          stt.SpeechEventType.START_OF_SPEECH,
        ]),
      );
    } finally {
      stream.close();
      await collectEvents;
    }
  });
});

function frame(value: number): AudioFrame {
  return new AudioFrame(new Int16Array([value]), 16000, 1, 1);
}
