// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';

export enum VADEventType {
  START_OF_SPEECH = 1,
  SPEAKING = 2,
  END_OF_SPEECH = 3,
}

export interface VADEvent {
  type: VADEventType;
  samplesIndex: number;
  duration: number;
  speech: AudioFrame[];
}

export abstract class VAD {
  abstract stream({
    minSpeakingDuration,
    minSilenceDuration,
    paddingDuration,
    sampleRate,
    maxBufferedSpeech,
  }: {
    minSpeakingDuration: number;
    minSilenceDuration: number;
    paddingDuration: number;
    sampleRate: number;
    maxBufferedSpeech: number;
  }): VADStream;
}

export abstract class VADStream implements IterableIterator<VADEvent> {
  abstract pushFrame(frame: AudioFrame): void;
  abstract close(wait: boolean): Promise<void>;
  abstract next(): IteratorResult<VADEvent>;
  [Symbol.iterator](): VADStream {
    return this;
  }
}
