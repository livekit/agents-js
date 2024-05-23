// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { AudioBuffer } from '../utils.js';

export enum SpeechEventType {
  /**
   * Indicate the start of speech.
   * If the STT doesn't support this event, this will be emitted at the same time
   * as the first INTERMIN_TRANSCRIPT.
   */
  START_OF_SPEECH = 0,
  /**
   * Interim transcript, useful for real-time transcription.
   */
  INTERIM_TRANSCRIPT = 1,
  /**
   * Final transcript, emitted when the STT is confident enough that a certain
   * portion of the speech will not change.
   */
  FINAL_TRANSCRIPT = 2,
  /**
   * Indicate the end of speech, emitted when the user stops speaking.
   * The first alternative is a combination of all the previous FINAL_TRANSCRIPT events.
   */
  END_OF_SPEECH = 3,
}

export interface SpeechData {
  language: string;
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
}

export class SpeechEvent {
  type: SpeechEventType;
  alternatives: SpeechData[];

  constructor(type: SpeechEventType, alternatives: SpeechData[] = []) {
    this.type = type;
    this.alternatives = alternatives;
  }
}

export abstract class SpeechStream implements IterableIterator<SpeechEvent> {
  /**
   * Push a frame to be recognised.
   * It is recommended to push frames as soon as they are available.
   */
  abstract pushFrame(token: AudioFrame): void;

  /**
   * Close the stream.
   *
   * @param wait
   *   Whether to wait for the STT to finish processing the remaining
   *   frames before closing
   */
  abstract close(wait: boolean): Promise<void>;

  abstract next(): IteratorResult<SpeechEvent>;

  [Symbol.iterator](): SpeechStream {
    return this;
  }
}

export abstract class STT {
  #streamingSupported: boolean;

  constructor(streamingSupported: boolean) {
    this.#streamingSupported = streamingSupported;
  }

  abstract recognize(buffer: AudioBuffer, language?: string): Promise<SpeechEvent>;

  abstract stream(language: string | undefined): SpeechStream;

  get streamingSupported(): boolean {
    return this.#streamingSupported;
  }
}
