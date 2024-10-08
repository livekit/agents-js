// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { AsyncIterableQueue } from './utils.js';

/** Indicates start/end of speech */
export enum VADEventType {
  START_OF_SPEECH,
  INFERENCE_DONE,
  END_OF_SPEECH,
}

/** VADEvent is a packet of VAD data */
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

/** Describes the capabilities of the STT provider. */
export interface VADCapabilities {
  updateInterval: number;
}

/**
 * An instance of a voice activity detection adapter.
 *
 * @remarks
 * This class is abstract, and as such cannot be used directly. Instead, use a provider plugin that
 * exports its own child VAD class, which inherits this class's methods.
 */
export abstract class VAD {
  #capabilities: VADCapabilities;
  constructor(capabilities: VADCapabilities) {
    this.#capabilities = capabilities;
  }

  /** Returns this STT's capabilities */
  get capabilities(): VADCapabilities {
    return this.#capabilities;
  }

  /**
   * Returns a {@link VADStream} that can be used to push audio frames and receive VAD events.
   */
  abstract stream(): VADStream;
}

/**
 * An instance of a voice activity detection stream, as an asynchronous iterable iterator.
 *
 * @example Looping through frames
 * ```ts
 * for await (const event of stream) {
 *   if (event.type === VADEventType.START_OF_SPEECH) {
 *     console.log('speech started')
 *   } else if (event.type === VADEventType.END_OF_SPEECH) {
 *     console.log('speech ended')
 *   }
 * }
 * ```
 *
 * @remarks
 * This class is abstract, and as such cannot be used directly. Instead, use a provider plugin that
 * exports its own child VADStream class, which inherits this class's methods.
 */
export abstract class VADStream implements AsyncIterableIterator<VADEvent> {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new AsyncIterableQueue<AudioFrame | typeof VADStream.FLUSH_SENTINEL>();
  protected queue = new AsyncIterableQueue<VADEvent>();
  protected closed = false;

  /** Push an audio frame to the VAD */
  pushFrame(frame: AudioFrame) {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(frame);
  }

  /** Flush the VAD, causing it to process all pending text */
  flush() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(VADStream.FLUSH_SENTINEL);
  }

  /** Mark the input as ended and forbid additional pushes */
  endInput() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.close();
  }

  /** @ignore */
  next(): Promise<IteratorResult<VADEvent>> {
    return this.queue.next();
  }

  /** Close both the input and output of the VAD stream */
  close() {
    this.input.close();
    this.queue.close();
    this.closed = true;
  }

  /** @ignore */
  [Symbol.asyncIterator](): VADStream {
    return this;
  }
}
