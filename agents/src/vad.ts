// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { VADMetrics } from './metrics/base.js';
import { AsyncIterableQueue } from './utils.js';

export enum VADEventType {
  START_OF_SPEECH,
  INFERENCE_DONE,
  END_OF_SPEECH,
  METRICS_COLLECTED,
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
  /** Duration of the speech segment. */
  speechDuration: number;
  /** Duration of the silence segment. */
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
  /** Threshold used to detect silence. */
  rawAccumulatedSilence: number;
  /** Threshold used to detect speech. */
  rawAccumulatedSpeech: number;
}

export interface VADCapabilities {
  updateInterval: number;
}

export type VADCallbacks = {
  [VADEventType.METRICS_COLLECTED]: (metrics: VADMetrics) => void;
};

export abstract class VAD extends (EventEmitter as new () => TypedEmitter<VADCallbacks>) {
  #capabilities: VADCapabilities;
  abstract label: string;

  constructor(capabilities: VADCapabilities) {
    super();
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
  protected output = new AsyncIterableQueue<VADEvent>();
  protected closed = false;
  #vad: VAD;
  #lastActivityTime = BigInt(0);

  constructor(vad: VAD) {
    this.#vad = vad;
    this.monitorMetrics();
  }

  protected async monitorMetrics() {
    let inferenceDurationTotal = 0;
    let inferenceCount = 0;

    for await (const event of this.queue) {
      this.output.put(event);
      switch (event.type) {
        case VADEventType.START_OF_SPEECH:
          inferenceCount++;
          if (inferenceCount >= 1 / this.#vad.capabilities.updateInterval) {
            this.#vad.emit(VADEventType.METRICS_COLLECTED, {
              timestamp: Date.now(),
              idleTime: Math.trunc(
                Number((process.hrtime.bigint() - this.#lastActivityTime) / BigInt(1000000)),
              ),
              inferenceDurationTotal,
              inferenceCount,
              label: this.#vad.label,
            });

            inferenceCount = 0;
            inferenceDurationTotal = 0;
          }
          break;
        case VADEventType.INFERENCE_DONE:
        case VADEventType.END_OF_SPEECH:
          this.#lastActivityTime = process.hrtime.bigint();
          break;
      }
    }
    this.output.close();
  }

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
    return this.output.next();
  }

  close() {
    this.input.close();
    this.queue.close();
    this.output.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): VADStream {
    return this;
  }
}
