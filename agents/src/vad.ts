// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type {
  ReadableStream,
  ReadableStreamDefaultReader,
  WritableStreamDefaultWriter,
} from 'node:stream/web';
import { TransformStream } from 'node:stream/web';
import type { VADMetrics } from './metrics/base.js';

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
  protected input = new TransformStream<
    AudioFrame | typeof VADStream.FLUSH_SENTINEL,
    AudioFrame | typeof VADStream.FLUSH_SENTINEL
  >();
  protected output = new TransformStream<VADEvent, VADEvent>();
  protected closed = false;
  protected inputClosed = false;
  #vad: VAD;
  #lastActivityTime = BigInt(0);
  #writer: WritableStreamDefaultWriter<AudioFrame | typeof VADStream.FLUSH_SENTINEL>;
  #reader: ReadableStreamDefaultReader<VADEvent>;

  constructor(vad: VAD) {
    this.#vad = vad;
    const [r1, r2] = this.output.readable.tee();
    this.#reader = r1.getReader();
    this.#writer = this.input.writable.getWriter();
    this.monitorMetrics(r2);
  }

  protected async monitorMetrics(readable: ReadableStream<VADEvent>) {
    let inferenceDurationTotal = 0;
    let inferenceCount = 0;

    for await (const event of readable) {
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
  }

  pushFrame(frame: AudioFrame) {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.#writer.write(frame);
  }

  flush() {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputClosed = true;
    this.#writer.write(VADStream.FLUSH_SENTINEL);
  }

  endInput() {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputClosed = true;
    this.input.writable.close();
  }

  async next(): Promise<IteratorResult<VADEvent>> {
    return this.#reader.read().then(({ value }) => {
      if (value) {
        return { value, done: false };
      } else {
        return { value: undefined, done: true };
      }
    });
  }

  close() {
    this.input.writable.close();
    this.output.writable.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): VADStream {
    return this;
  }
}
