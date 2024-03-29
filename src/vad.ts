// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { AudioFrame } from '@livekit/rtc-node';

export enum VADEventType {
  START_OF_SPEECH = 1,
  SPEAKING = 2,
  END_OF_SPEECH = 3,
}

interface VADEvent {
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

export abstract class VADStream {
  abstract pushFrame(frame: AudioFrame): void;
  abstract aclose(wait: boolean): Promise<void>;
  abstract anext(): Promise<VADEvent>;
  private aiter(): VADStream {
    return this;
  }
}
