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
import type { TTSMetrics } from '../metrics/base.js';
import { mergeFrames } from '../utils.js';

/** SynthesizedAudio is a packet of speech synthesis as returned by the TTS. */
export interface SynthesizedAudio {
  /** Request ID (one segment could be made up of multiple requests) */
  requestId: string;
  /** Segment ID, each segment is separated by a flush */
  segmentId: string;
  /** Synthesized audio frame */
  frame: AudioFrame;
  /** Current segment of the synthesized audio */
  deltaText?: string;
  /** Whether this is the last frame of the segment (streaming only) */
  final: boolean;
}

/**
 * Describes the capabilities of the TTS provider.
 *
 * @remarks
 * At present, only `streaming` is supplied to this interface, and the framework only supports
 * providers that do have a streaming endpoint.
 */
export interface TTSCapabilities {
  streaming: boolean;
}

export enum TTSEvent {
  METRICS_COLLECTED,
}

export type TTSCallbacks = {
  [TTSEvent.METRICS_COLLECTED]: (metrics: TTSMetrics) => void;
};

/**
 * An instance of a text-to-speech adapter.
 *
 * @remarks
 * This class is abstract, and as such cannot be used directly. Instead, use a provider plugin that
 * exports its own child TTS class, which inherits this class's methods.
 */
export abstract class TTS extends (EventEmitter as new () => TypedEmitter<TTSCallbacks>) {
  #capabilities: TTSCapabilities;
  #sampleRate: number;
  #numChannels: number;
  abstract label: string;

  constructor(sampleRate: number, numChannels: number, capabilities: TTSCapabilities) {
    super();
    this.#capabilities = capabilities;
    this.#sampleRate = sampleRate;
    this.#numChannels = numChannels;
  }

  /** Returns this TTS's capabilities */
  get capabilities(): TTSCapabilities {
    return this.#capabilities;
  }

  /** Returns the sample rate of audio frames returned by this TTS */
  get sampleRate(): number {
    return this.#sampleRate;
  }

  /** Returns the channel count of audio frames returned by this TTS */
  get numChannels(): number {
    return this.#numChannels;
  }

  /**
   * Receives text and returns synthesis in the form of a {@link ChunkedStream}
   */
  abstract synthesize(text: string): ChunkedStream;

  /**
   * Returns a {@link SynthesizeStream} that can be used to push text and receive audio data
   */
  abstract stream(): SynthesizeStream;
}

/**
 * An instance of a text-to-speech stream, as an asynchronous iterable iterator.
 *
 * @example Looping through frames
 * ```ts
 * for await (const event of stream) {
 *   await source.captureFrame(event.frame);
 * }
 * ```
 *
 * @remarks
 * This class is abstract, and as such cannot be used directly. Instead, use a provider plugin that
 * exports its own child SynthesizeStream class, which inherits this class's methods.
 */
export abstract class SynthesizeStream
  implements AsyncIterableIterator<SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM>
{
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');
  static readonly END_OF_STREAM = Symbol('END_OF_STREAM');
  protected input = new TransformStream<
    string | typeof SynthesizeStream.FLUSH_SENTINEL,
    string | typeof SynthesizeStream.FLUSH_SENTINEL
  >();
  protected output = new TransformStream<
    SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM,
    SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM
  >();
  protected closed = false;
  protected inputClosed = false;
  abstract label: string;
  #tts: TTS;
  #metricsPendingTexts: string[] = [];
  #metricsText = '';
  #writer: WritableStreamDefaultWriter<string | typeof SynthesizeStream.FLUSH_SENTINEL>;
  #reader: ReadableStreamDefaultReader<SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM>;

  constructor(tts: TTS) {
    this.#tts = tts;
    this.#writer = this.input.writable.getWriter();
    const [r1, r2] = this.output.readable.tee();
    this.#reader = r1.getReader();
    this.monitorMetrics(r2);
  }

  protected async monitorMetrics(
    readable: ReadableStream<SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM>,
  ) {
    const startTime = process.hrtime.bigint();
    let audioDuration = 0;
    let ttfb: bigint | undefined;
    let requestId = '';

    const emit = () => {
      if (this.#metricsPendingTexts.length) {
        const text = this.#metricsPendingTexts.shift()!;
        const duration = process.hrtime.bigint() - startTime;
        const metrics: TTSMetrics = {
          timestamp: Date.now(),
          requestId,
          ttfb: Math.trunc(Number(ttfb! / BigInt(1000000))),
          duration: Math.trunc(Number(duration / BigInt(1000000))),
          charactersCount: text.length,
          audioDuration,
          cancelled: false, // XXX(nbsp)
          label: this.label,
          streamed: false,
        };
        this.#tts.emit(TTSEvent.METRICS_COLLECTED, metrics);
      }
    };

    for await (const audio of readable) {
      if (audio === SynthesizeStream.END_OF_STREAM) continue;
      requestId = audio.requestId;
      if (!ttfb) {
        ttfb = process.hrtime.bigint() - startTime;
      }
      audioDuration += audio.frame.samplesPerChannel / audio.frame.sampleRate;
      if (audio.final) {
        emit();
      }
    }

    if (requestId) {
      emit();
    }
  }

  /** Push a string of text to the TTS */
  pushText(text: string) {
    this.#metricsText += text;

    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.#writer.write(text);
  }

  /** Flush the TTS, causing it to process all pending text */
  flush() {
    if (this.#metricsText) {
      this.#metricsPendingTexts.push(this.#metricsText);
      this.#metricsText = '';
    }
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.#writer.write(SynthesizeStream.FLUSH_SENTINEL);
  }

  /** Mark the input as ended and forbid additional pushes */
  endInput() {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.#writer.close();
    this.inputClosed = true;
  }

  async next(): Promise<IteratorResult<SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM>> {
    return this.#reader.read().then(({ value }) => {
      if (value) {
        return { value, done: false };
      } else {
        return { value: undefined, done: true };
      }
    });
  }

  /** Close both the input and output of the TTS stream */
  close() {
    this.endInput();
    this.closed = true;
  }

  [Symbol.asyncIterator](): SynthesizeStream {
    return this;
  }
}

/**
 * An instance of a text-to-speech response, as an asynchronous iterable iterator.
 *
 * @example Looping through frames
 * ```ts
 * for await (const event of stream) {
 *   await source.captureFrame(event.frame);
 * }
 * ```
 *
 * @remarks
 * This class is abstract, and as such cannot be used directly. Instead, use a provider plugin that
 * exports its own child ChunkedStream class, which inherits this class's methods.
 */
export abstract class ChunkedStream implements AsyncIterableIterator<SynthesizedAudio> {
  protected output = new TransformStream<SynthesizedAudio, SynthesizedAudio>();
  protected closed = false;
  abstract label: string;
  #text: string;
  #tts: TTS;
  #reader: ReadableStreamDefaultReader<SynthesizedAudio>;

  constructor(text: string, tts: TTS) {
    this.#text = text;
    this.#tts = tts;
    const [r1, r2] = this.output.readable.tee();
    this.#reader = r1.getReader();
    this.monitorMetrics(r2);
  }

  protected async monitorMetrics(readable: ReadableStream<SynthesizedAudio>) {
    const startTime = process.hrtime.bigint();
    let audioDuration = 0;
    let ttfb: bigint | undefined;
    let requestId = '';

    for await (const audio of readable) {
      requestId = audio.requestId;
      if (!ttfb) {
        ttfb = process.hrtime.bigint() - startTime;
      }
      audioDuration += audio.frame.samplesPerChannel / audio.frame.sampleRate;
    }

    const duration = process.hrtime.bigint() - startTime;
    const metrics: TTSMetrics = {
      timestamp: Date.now(),
      requestId,
      ttfb: Math.trunc(Number(ttfb! / BigInt(1000000))),
      duration: Math.trunc(Number(duration / BigInt(1000000))),
      charactersCount: this.#text.length,
      audioDuration,
      cancelled: false, // XXX(nbsp)
      label: this.label,
      streamed: false,
    };
    this.#tts.emit(TTSEvent.METRICS_COLLECTED, metrics);
  }

  /** Collect every frame into one in a single call */
  async collect(): Promise<AudioFrame> {
    const frames = [];
    for await (const event of this) {
      frames.push(event.frame);
    }
    return mergeFrames(frames);
  }

  async next(): Promise<IteratorResult<SynthesizedAudio>> {
    return this.#reader.read().then(({ value }) => {
      if (value) {
        return { value, done: false };
      } else {
        return { value: undefined, done: true };
      }
    });
  }

  /** Close both the input and output of the TTS stream */
  close() {
    this.output.writable.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): ChunkedStream {
    return this;
  }
}
