// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { calculateAudioDurationSeconds } from '../audio.js';
import { log } from '../log.js';
import type { STTMetrics } from '../metrics/base.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import type { AudioBuffer } from '../utils.js';
import { AsyncIterableQueue, delay, startSoon, toError } from '../utils.js';

/** Indicates start/middle/end of speech */
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
  /** Usage event, emitted periodically to indicate usage metrics. */
  RECOGNITION_USAGE = 4,
  /**
   * Preflight transcript, emitted before final transcript when STT has high confidence
   * but hasn't fully committed yet. Includes all pre-committed transcripts including
   * final transcript from the previous STT run.
   */
  PREFLIGHT_TRANSCRIPT = 5,
}

/** SpeechData contains metadata about this {@link SpeechEvent}. */
export interface SpeechData {
  language: string;
  text: string;
  startTime: number;
  endTime: number;
  confidence: number;
}

export interface RecognitionUsage {
  audioDuration: number;
}

/** SpeechEvent is a packet of speech-to-text data. */
export interface SpeechEvent {
  type: SpeechEventType;
  alternatives?: [SpeechData, ...SpeechData[]];
  requestId?: string;
  recognitionUsage?: RecognitionUsage;
}

/**
 * Describes the capabilities of the STT provider.
 *
 * @remarks
 * At present, the framework only supports providers that have a streaming endpoint.
 */
export interface STTCapabilities {
  streaming: boolean;
  interimResults: boolean;
}

export interface STTError {
  type: 'stt_error';
  timestamp: number;
  label: string;
  error: Error;
  recoverable: boolean;
}

export type STTCallbacks = {
  ['metrics_collected']: (metrics: STTMetrics) => void;
  ['error']: (error: STTError) => void;
};

/**
 * An instance of a speech-to-text adapter.
 *
 * @remarks
 * This class is abstract, and as such cannot be used directly. Instead, use a provider plugin that
 * exports its own child STT class, which inherits this class's methods.
 */
export abstract class STT extends (EventEmitter as new () => TypedEmitter<STTCallbacks>) {
  abstract label: string;
  #capabilities: STTCapabilities;

  constructor(capabilities: STTCapabilities) {
    super();
    this.#capabilities = capabilities;
  }

  /** Returns this STT's capabilities */
  get capabilities(): STTCapabilities {
    return this.#capabilities;
  }

  /** Receives an audio buffer and returns transcription in the form of a {@link SpeechEvent} */
  async recognize(frame: AudioBuffer): Promise<SpeechEvent> {
    const startTime = process.hrtime.bigint();
    const event = await this._recognize(frame);
    const durationMs = Number((process.hrtime.bigint() - startTime) / BigInt(1000000));
    this.emit('metrics_collected', {
      type: 'stt_metrics',
      requestId: event.requestId ?? '',
      timestamp: Date.now(),
      durationMs,
      label: this.label,
      audioDurationMs: Math.round(calculateAudioDurationSeconds(frame) * 1000),
      streamed: false,
    });
    return event;
  }
  protected abstract _recognize(frame: AudioBuffer): Promise<SpeechEvent>;

  /**
   * Returns a {@link SpeechStream} that can be used to push audio frames and receive
   * transcriptions
   */
  abstract stream(): SpeechStream;

  async close(): Promise<void> {
    return;
  }
}

/**
 * An instance of a speech-to-text stream, as an asynchronous iterable iterator.
 *
 * @example Looping through frames
 * ```ts
 * for await (const event of stream) {
 *   if (event.type === SpeechEventType.FINAL_TRANSCRIPT) {
 *     console.log(event.alternatives[0].text)
 *   }
 * }
 * ```
 *
 * @remarks
 * This class is abstract, and as such cannot be used directly. Instead, use a provider plugin that
 * exports its own child SpeechStream class, which inherits this class's methods.
 */
export abstract class SpeechStream implements AsyncIterableIterator<SpeechEvent> {
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  protected input = new AsyncIterableQueue<AudioFrame | typeof SpeechStream.FLUSH_SENTINEL>();
  protected output = new AsyncIterableQueue<SpeechEvent>();
  protected queue = new AsyncIterableQueue<SpeechEvent>();
  protected neededSampleRate?: number;
  protected resampler?: AudioResampler;
  abstract label: string;
  protected closed = false;
  #stt: STT;
  private deferredInputStream: DeferredReadableStream<AudioFrame>;
  private logger = log();
  private _connOptions: APIConnectOptions;

  constructor(
    stt: STT,
    sampleRate?: number,
    connectionOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
  ) {
    this.#stt = stt;
    this._connOptions = connectionOptions;
    this.deferredInputStream = new DeferredReadableStream<AudioFrame>();
    this.neededSampleRate = sampleRate;
    this.monitorMetrics();
    this.pumpInput();

    // this is a hack to immitate asyncio.create_task so that mainTask
    // is run **after** the constructor has finished. Otherwise we get
    // runtime error when trying to access class variables in the
    // `run` method.
    startSoon(() => this.mainTask().then(() => this.queue.close()));
  }

  private async mainTask() {
    for (let i = 0; i < this._connOptions.maxRetry + 1; i++) {
      try {
        return await this.run();
      } catch (error) {
        if (error instanceof APIError) {
          const retryInterval = this._connOptions._intervalForRetry(i);

          if (this._connOptions.maxRetry === 0 || !error.retryable) {
            this.emitError({ error, recoverable: false });
            throw error;
          } else if (i === this._connOptions.maxRetry) {
            this.emitError({ error, recoverable: false });
            throw new APIConnectionError({
              message: `failed to recognize speech after ${this._connOptions.maxRetry + 1} attempts`,
              options: { retryable: false },
            });
          } else {
            // Don't emit error event for recoverable errors during retry loop
            // to avoid ERR_UNHANDLED_ERROR or premature session termination
            this.logger.warn(
              { tts: this.#stt.label, attempt: i + 1, error },
              `failed to recognize speech, retrying in ${retryInterval}s`,
            );
          }

          if (retryInterval > 0) {
            await delay(retryInterval);
          }
        } else {
          this.emitError({ error: toError(error), recoverable: false });
          throw error;
        }
      }
    }
  }

  private emitError({ error, recoverable }: { error: Error; recoverable: boolean }) {
    this.#stt.emit('error', {
      type: 'stt_error',
      timestamp: Date.now(),
      label: this.#stt.label,
      error,
      recoverable,
    });
  }

  protected async pumpInput() {
    // TODO(AJS-35): Implement STT with webstreams API
    const inputStream = this.deferredInputStream.stream;
    const reader = inputStream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.pushFrame(value);
      }
    } catch (error) {
      this.logger.error('Error in STTStream mainTask:', error);
    } finally {
      reader.releaseLock();
    }
  }

  protected async monitorMetrics() {
    for await (const event of this.queue) {
      this.output.put(event);
      if (event.type !== SpeechEventType.RECOGNITION_USAGE) continue;
      const metrics: STTMetrics = {
        type: 'stt_metrics',
        timestamp: Date.now(),
        requestId: event.requestId!,
        durationMs: 0,
        label: this.#stt.label,
        audioDurationMs: Math.round(event.recognitionUsage!.audioDuration * 1000),
        streamed: true,
      };
      this.#stt.emit('metrics_collected', metrics);
    }
    this.output.close();
  }

  protected abstract run(): Promise<void>;

  updateInputStream(audioStream: ReadableStream<AudioFrame>) {
    this.deferredInputStream.setSource(audioStream);
  }

  detachInputStream() {
    this.deferredInputStream.detachSource();
  }

  /** Push an audio frame to the STT */
  pushFrame(frame: AudioFrame) {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }

    if (this.neededSampleRate && frame.sampleRate !== this.neededSampleRate) {
      if (!this.resampler) {
        this.resampler = new AudioResampler(frame.sampleRate, this.neededSampleRate);
      }
    }

    if (this.resampler) {
      const frames = this.resampler.push(frame);
      for (const frame of frames) {
        this.input.put(frame);
      }
    } else {
      this.input.put(frame);
    }
  }

  /** Flush the STT, causing it to process all pending text */
  flush() {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(SpeechStream.FLUSH_SENTINEL);
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

  next(): Promise<IteratorResult<SpeechEvent>> {
    return this.output.next();
  }

  /** Close both the input and output of the STT stream */
  close() {
    this.input.close();
    this.queue.close();
    this.output.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): SpeechStream {
    return this;
  }
}
