// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { AsyncIterableQueue } from '../utils.js';

export enum SpeechEventType {
  /**
   * Indicate the start of speech.
   * If the STT doesn't support this event, this will be emitted at the same time
   * as the first INTERIM_TRANSCRIPT.
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

export interface SpeechEvent {
  type: SpeechEventType;
  alternatives: SpeechData[];
}

export interface STTCapabilities {
  streaming: boolean;
  interimResults: boolean;
}

export abstract class STT {
  #capabilities: STTCapabilities;

  constructor(capabilities: STTCapabilities) {
    this.#capabilities = capabilities;
  }

  get capabilities(): STTCapabilities {
    return this.#capabilities;
  }

  /**
   * Returns a {@link SpeechStream} that can be used to push audio frames and receive syntheses.
   */
  abstract stream(): SpeechStream;
}

export abstract class SpeechStream implements AsyncIterableIterator<SpeechEvent> {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new AsyncIterableQueue<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL>();
  protected queue = new AsyncIterableQueue<SpeechEvent>();
  protected closed = false;

  pushFrame(frame: AudioFrame) {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(frame);
  }

  flush() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(SpeechStream.FLUSH_SENTINEL);
  }

  endInput() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.close();
  }

  next(): Promise<IteratorResult<SpeechEvent>> {
    return this.queue.next();
  }

  close() {
    this.input.close();
    this.queue.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): SpeechStream {
    return this;
  }
}
