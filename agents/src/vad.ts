// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { AsyncIterableQueue } from './utils.js';

export enum VADEventType {
  START_OF_SPEECH,
  INFERENCE_DONE,
  END_OF_SPEECH,
}

export interface VADEvent {
  /** Type of the VAD event (e.g., start of speech, end of speech, inference done). */
  type: VADEventType;
  /**
   * Index of the audio sample where the event occurred, relative to the inference sample rate.
   */
  samplesIndex: number;
  /** Timestamp when the event was fired. */
  timestamp: number;
  /** Duration of the detected speech segment in seconds. */
  speechDuration: number;
  /** Duration of the silence segment preceding or following the speech, in seconds. */
  silenceDuration: number;
  /**
   * List of audio frames associated with the speech.
   *
   * @remarks
   * - For `start_of_speech` events, this contains the audio chunks that triggered the detection.
   * - For `inference_done` events, this contains the audio chunks that were processed.
   * - For `end_of_speech` events, this contains the complete user speech.
   */
  frames: AudioFrame[];
  /** Probability that speech is present (only for `INFERENCE_DONE` events). */
  probability: number;
  /** Time taken to perform the inference, in seconds (only for `INFERENCE_DONE` events). */
  inferenceDuration: number;
  /** Indicates whether speech was detected in the frames. */
  speaking: boolean;
}

export interface VADCapabilities {
  updateInterval: number;
}

export abstract class VAD {
  #capabilities: VADCapabilities;
  constructor(capabilities: VADCapabilities) {
    this.#capabilities = capabilities;
  }

  get capabilities(): VADCapabilities {
    return this.#capabilities;
  }

  /**
   * Returns a {@link VADStream} that can be used to push audio frames and receive VAD events.
   */
  abstract stream(): VADStream;
}

export abstract class VADStream implements AsyncIterableIterator<VADEvent> {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new AsyncIterableQueue<AudioFrame | typeof VADStream.FLUSH_SENTINEL>();
  protected queue = new AsyncIterableQueue<VADEvent>();
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
    this.input.put(VADStream.FLUSH_SENTINEL);
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

  next(): Promise<IteratorResult<VADEvent>> {
    return this.queue.next();
  }

  close() {
    this.input.close();
    this.queue.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): VADStream {
    return this;
  }
}
