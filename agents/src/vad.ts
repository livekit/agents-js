// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import { log } from './log.js';
import type { VADMetrics } from './metrics/base.js';
import { Chan, ChanClosed } from './stream/chan.js';
import { tee } from './stream/tee.js';

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
  /** Duration of the speech segment in seconds. */
  speechDuration: number;
  /** Duration of the silence segment in seconds. */
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
  /** Duration of each VAD inference window in milliseconds. Used to batch metrics emissions to roughly once per second. */
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
  protected inputChan = new Chan<AudioFrame | typeof VADStream.FLUSH_SENTINEL>();
  protected outputChan = new Chan<VADEvent>();
  protected closed = false;
  protected inputClosed = false;

  protected vad: VAD;
  protected lastActivityTime = BigInt(0);
  protected logger;
  private _pumpAbort: AbortController | null = null;

  private outputTee: ReturnType<typeof tee<VADEvent>> | null = null;
  private outputIter: AsyncIterableIterator<VADEvent> | null = null;
  private metricsIter: AsyncIterableIterator<VADEvent> | null = null;

  constructor(vad: VAD) {
    this.logger = log();
    this.vad = vad;

    // Tee the output channel into two iterators: one for consumer, one for metrics
    this.outputTee = tee(this.outputChan, 2);
    this.outputIter = this.outputTee[0][Symbol.asyncIterator]();
    this.metricsIter = this.outputTee[1][Symbol.asyncIterator]();

    this.monitorMetrics();
  }

  protected async monitorMetrics() {
    let inferenceDurationTotalMs = 0;
    let inferenceCount = 0;
    if (!this.metricsIter) return;
    while (true) {
      const { done, value } = await this.metricsIter.next();
      if (done) {
        break;
      }
      switch (value.type) {
        case VADEventType.START_OF_SPEECH:
          inferenceCount++;
          if (inferenceCount >= 1000 / this.vad.capabilities.updateInterval) {
            this.vad.emit('metrics_collected', {
              type: 'vad_metrics',
              timestamp: Date.now(),
              idleTimeMs: Math.trunc(
                Number((process.hrtime.bigint() - this.lastActivityTime) / BigInt(1000000)),
              ),
              inferenceDurationTotalMs,
              inferenceCount,
              label: this.vad.label,
            });

            inferenceCount = 0;
            inferenceDurationTotalMs = 0;
          }
          break;
        case VADEventType.INFERENCE_DONE:
          inferenceDurationTotalMs += Math.round(value.inferenceDuration);
          this.lastActivityTime = process.hrtime.bigint();
          break;
        case VADEventType.END_OF_SPEECH:
          this.lastActivityTime = process.hrtime.bigint();
          break;
      }
    }
  }

  /**
   * Safely send a VAD event to the output channel, handling close errors during shutdown.
   * @returns true if the event was sent, false if the channel is closing
   * @throws Error if an unexpected error occurs
   */
  protected sendVADEvent(event: VADEvent): boolean {
    if (this.closed) {
      return false;
    }

    try {
      this.outputChan.sendNowait(event);
      return true;
    } catch (e) {
      if (e instanceof ChanClosed) return false;
      throw e;
    }
  }

  updateInputStream(audioStream: AsyncIterable<AudioFrame>) {
    this._pumpAbort?.abort();
    const abort = new AbortController();
    this._pumpAbort = abort;
    (async () => {
      try {
        for await (const frame of audioStream) {
          if (abort.signal.aborted) break;
          try {
            this.inputChan.sendNowait(frame);
          } catch (e) {
            if (e instanceof ChanClosed) break;
            throw e;
          }
        }
      } catch {
        // Source errors are silently consumed
      }
    })();
  }

  detachInputStream() {
    this._pumpAbort?.abort();
    this._pumpAbort = null;
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
    try {
      this.inputChan.sendNowait(frame);
    } catch (e) {
      if (e instanceof ChanClosed) return;
      throw e;
    }
  }

  flush() {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    try {
      this.inputChan.sendNowait(VADStream.FLUSH_SENTINEL);
    } catch (e) {
      if (e instanceof ChanClosed) return;
      throw e;
    }
  }

  endInput() {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputClosed = true;
    this.inputChan.close();
  }

  async next(): Promise<IteratorResult<VADEvent>> {
    if (!this.outputIter) {
      return { done: true, value: undefined };
    }
    return this.outputIter.next();
  }

  close() {
    this._pumpAbort?.abort();
    this.inputChan.close();
    this.outputChan.close();
    if (this.outputTee) {
      this.outputTee.aclose();
    }
    this.closed = true;
  }

  [Symbol.asyncIterator](): VADStream {
    return this;
  }
}
