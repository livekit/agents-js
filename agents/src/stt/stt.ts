// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { AudioFrame } from '@livekit/rtc-node';
import { AudioBuffer } from '../utils';

export enum SpeechEventType {
  START_OF_SPEECH = 0,
  INTERIM_TRANSCRIPT = 1,
  FINAL_TRANSCRIPT = 2,
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
  abstract pushFrame(token: AudioFrame): void;

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
