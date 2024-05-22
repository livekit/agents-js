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
  /**
   * Index of the samples of the event (when the event was fired)
   */
  samplesIndex: number;
  /**
   * Duration of speech, in seconds
   */
  duration: number;
  speech: AudioFrame[];
}

export abstract class VAD {
  /**
   * Returns a {@link VADStream} that can be used to push audio frames and receive VAD events.
   *
   * @param options
   */
  abstract stream({
    minSpeakingDuration,
    minSilenceDuration,
    paddingDuration,
    sampleRate,
    maxBufferedSpeech,
  }: {
    /**
     * Minimum duration of speech required to trigger a {@link VADEventType.START_OF_SPEECH} event
     */
    minSpeakingDuration: number;
    /**
     * Milliseconds to wait before separating speech chunk.
     * Not always precise, generally rounded to the nearest 40ms depending on VAD implementation
     */
    minSilenceDuration: number;
    /**
     * Number of frames to pad the start and end of speech with
     */
    paddingDuration: number;
    /**
     * Sample rate of inference/processing
     */
    sampleRate: number;
    /**
     * Number of seconds the buffer may keep until {@link VADEventType.END_OF_SPEECH} is triggered.
     * It is recommended to set this to a positive value, as zero may OOM if the user doesn't stop
     * speaking.
     */
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
