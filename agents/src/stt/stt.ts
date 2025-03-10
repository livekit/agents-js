// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { STTMetrics } from '../metrics/base.js';
import type { AudioBuffer } from '../utils.js';
import { AsyncIterableQueue } from '../utils.js';

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
  METRICS_COLLECTED = 5,
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

export type STTCallbacks = {
  [SpeechEventType.METRICS_COLLECTED]: (metrics: STTMetrics) => void;
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
    const duration = Number((process.hrtime.bigint() - startTime) / BigInt(1000000));
    this.emit(SpeechEventType.METRICS_COLLECTED, {
      requestId: event.requestId ?? '',
      timestamp: Date.now(),
      duration,
      label: this.label,
      audioDuration: Array.isArray(frame)
        ? frame.reduce((sum, a) => sum + a.samplesPerChannel / a.sampleRate, 0)
        : frame.samplesPerChannel / frame.sampleRate,
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
  abstract label: string;
  protected closed = false;
  #stt: STT;

  constructor(stt: STT) {
    this.#stt = stt;
    this.monitorMetrics();
  }

  protected async monitorMetrics() {
    const startTime = process.hrtime.bigint();

    for await (const event of this.queue) {
      this.output.put(event);
      if (event.type !== SpeechEventType.RECOGNITION_USAGE) continue;
      const duration = process.hrtime.bigint() - startTime;
      const metrics: STTMetrics = {
        timestamp: Date.now(),
        requestId: event.requestId!,
        duration: Math.trunc(Number(duration / BigInt(1000000))),
        label: this.label,
        audioDuration: event.recognitionUsage!.audioDuration,
        streamed: true,
      };
      this.#stt.emit(SpeechEventType.METRICS_COLLECTED, metrics);
    }
    this.output.close();
  }

  /** Push an audio frame to the STT */
  pushFrame(frame: AudioFrame) {
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(frame);
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
