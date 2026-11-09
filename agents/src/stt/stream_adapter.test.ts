// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioBuffer } from '../utils.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import { STT, type SpeechEvent, SpeechEventType, type SpeechStream } from './stt.js';

class BatchSTT extends STT {
  label = 'batch-stt';

  constructor(private readonly speechEndTime?: number) {
    super({ streaming: false, interimResults: false });
  }

  protected async _recognize(_frame: AudioBuffer): Promise<SpeechEvent> {
    return {
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ language: 'en', text: 'hello', startTime: 0, endTime: 0, confidence: 1 }],
      speechEndTime: this.speechEndTime,
    };
  }

  stream(): SpeechStream {
    throw new Error('not used');
  }
}

class ScriptedVAD extends VAD {
  label = 'scripted-vad';

  constructor(private readonly event: VADEvent) {
    super({ updateInterval: 32 });
  }

  stream(): VADStream {
    const event = this.event;
    return {
      pushFrame() {},
      flush() {},
      endInput() {},
      close() {},
      async *[Symbol.asyncIterator]() {
        yield event;
      },
    } as unknown as VADStream;
  }
}

function endOfSpeechEvent(frame: AudioFrame): VADEvent {
  return {
    type: VADEventType.END_OF_SPEECH,
    samplesIndex: 0,
    timestamp: 10_000,
    speechDuration: 1_000,
    silenceDuration: 500,
    frames: [frame],
    probability: 0,
    inferenceDuration: 100,
    speaking: false,
    rawAccumulatedSilence: 500,
    rawAccumulatedSpeech: 1_000,
  };
}

describe('StreamAdapter speech timing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { providerSpeechEndTime: undefined, expectedFinalSpeechEndTime: 9_400 },
    { providerSpeechEndTime: 9_200, expectedFinalSpeechEndTime: 9_200 },
  ])(
    'adds VAD timing and preserves provider timing: $providerSpeechEndTime',
    async ({ providerSpeechEndTime, expectedFinalSpeechEndTime }) => {
      vi.spyOn(Date, 'now').mockReturnValue(10_000);
      const frame = new AudioFrame(new Int16Array(160), 16_000, 1, 160);
      const stream = new StreamAdapter(
        new BatchSTT(providerSpeechEndTime),
        new ScriptedVAD(endOfSpeechEvent(frame)),
      ).stream();

      try {
        stream.pushFrame(frame);
        stream.endInput();

        const endEvent = (await stream.next()).value;
        const finalEvent = (await stream.next()).value;

        expect(endEvent).toMatchObject({
          type: SpeechEventType.END_OF_SPEECH,
          speechEndTime: 9_400,
        });
        expect(finalEvent).toMatchObject({
          type: SpeechEventType.FINAL_TRANSCRIPT,
          speechEndTime: expectedFinalSpeechEndTime,
        });
      } finally {
        stream.close();
      }
    },
  );
});
