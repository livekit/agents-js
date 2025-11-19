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
import { log } from './log.js';
import type { VADMetrics } from './metrics/base.js';
import { DeferredReadableStream } from './stream/deferred_stream.js';
import { IdentityTransform } from './stream/identity_transform.js';

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
  ['metrics_collected']: (metrics: VADMetrics) => void;
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

  async close(): Promise<void> {
    return;
  }
}

export abstract class VADStream implements AsyncIterableIterator<VADEvent> {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new IdentityTransform<AudioFrame | typeof VADStream.FLUSH_SENTINEL>();
  protected output = new IdentityTransform<VADEvent>();
  protected inputWriter: WritableStreamDefaultWriter<AudioFrame | typeof VADStream.FLUSH_SENTINEL>;
  protected inputReader: ReadableStreamDefaultReader<AudioFrame | typeof VADStream.FLUSH_SENTINEL>;
  protected outputWriter: WritableStreamDefaultWriter<VADEvent>;
  protected outputReader: ReadableStreamDefaultReader<VADEvent>;
  protected closed = false;
  protected inputClosed = false;

  #vad: VAD;
  #lastActivityTime = BigInt(0);
  private logger = log();
  private deferredInputStream: DeferredReadableStream<AudioFrame>;

  private metricsStream: ReadableStream<VADEvent>;
  constructor(vad: VAD) {
    this.#vad = vad;
    this.deferredInputStream = new DeferredReadableStream<AudioFrame>();

    this.inputWriter = this.input.writable.getWriter();
    this.inputReader = this.input.readable.getReader();
    this.outputWriter = this.output.writable.getWriter();

    const [outputStream, metricsStream] = this.output.readable.tee();
    this.metricsStream = metricsStream;
    this.outputReader = outputStream.getReader();

    this.pumpDeferredStream();
    this.monitorMetrics();
  }

  /**
   * Reads from the deferred input stream and forwards chunks to the input writer.
   *
   * Note: we can't just do this.deferredInputStream.stream.pipeTo(this.input.writable)
   * because the inputWriter locks the this.input.writable stream. All writes must go through
   * the inputWriter.
   */
  private async pumpDeferredStream() {
    const reader = this.deferredInputStream.stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.inputWriter.write(value);
      }
    } catch (e) {
      this.logger.error(`Error pumping deferred stream: ${e}`);
      throw e;
    } finally {
      reader.releaseLock();
    }
  }

  protected async monitorMetrics() {
    let inferenceDurationTotalMs = 0;
    let inferenceCount = 0;
    const metricsReader = this.metricsStream.getReader();
    while (true) {
      const { done, value } = await metricsReader.read();
      if (done) {
        break;
      }
      switch (value.type) {
        case VADEventType.START_OF_SPEECH:
          inferenceCount++;
          if (inferenceCount >= 1 / this.#vad.capabilities.updateInterval) {
            this.#vad.emit('metrics_collected', {
              type: 'vad_metrics',
              timestamp: Date.now(),
              idleTimeMs: Math.trunc(
                Number((process.hrtime.bigint() - this.#lastActivityTime) / BigInt(1000000)),
              ),
              inferenceDurationTotalMs,
              inferenceCount,
              label: this.#vad.label,
            });

            inferenceCount = 0;
            inferenceDurationTotalMs = 0;
          }
          break;
        case VADEventType.INFERENCE_DONE:
          inferenceDurationTotalMs += Math.round(value.inferenceDuration);
          this.#lastActivityTime = process.hrtime.bigint();
          break;
        case VADEventType.END_OF_SPEECH:
          this.#lastActivityTime = process.hrtime.bigint();
          break;
      }
    }
  }

  /**
   * Safely send a VAD event to the output stream, handling writer release errors during shutdown.
   * @returns true if the event was sent, false if the stream is closing
   * @throws Error if an unexpected error occurs
   */
  protected sendVADEvent(event: VADEvent): boolean {
    if (this.closed) {
      return false;
    }

    try {
      this.outputWriter.write(event);
      return true;
    } catch (e) {
      throw e;
    }
  }

  updateInputStream(audioStream: ReadableStream<AudioFrame>) {
    this.deferredInputStream.setSource(audioStream);
  }

  detachInputStream() {
    this.deferredInputStream.detachSource();
  }

  /** @deprecated Use `updateInputStream` instead */
  pushFrame(frame: AudioFrame) {
    // TODO(AJS-395): remove this method
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputWriter.write(frame);
  }

  flush() {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputWriter.write(VADStream.FLUSH_SENTINEL);
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
    return this.outputReader.read().then(({ done, value }) => {
      if (done) {
        return { done: true, value: undefined };
      }
      return { done: false, value };
    });
  }

  close() {
    this.outputWriter.releaseLock();
    this.outputReader.cancel();
    this.output.writable.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): VADStream {
    return this;
  }
}
