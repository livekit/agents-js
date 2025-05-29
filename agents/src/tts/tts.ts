// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import { log } from '../log.js';
import type { TTSMetrics } from '../metrics/base.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { IdentityTransform } from '../stream/identity_transform.js';
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
  protected inputReader: ReadableStreamDefaultReader<
    string | typeof SynthesizeStream.FLUSH_SENTINEL
  >;
  protected outputWriter: WritableStreamDefaultWriter<
    SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM
  >;
  protected closed = false;
  abstract label: string;
  #tts: TTS;
  #metricsPendingTexts: string[] = [];
  #metricsText = '';

  private deferredInputStream: DeferredReadableStream<
    string | typeof SynthesizeStream.FLUSH_SENTINEL
  >;
  protected metricsStream: ReadableStream<SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM>;
  private input = new IdentityTransform<string | typeof SynthesizeStream.FLUSH_SENTINEL>();
  private output = new IdentityTransform<
    SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM
  >();
  private inputWriter: WritableStreamDefaultWriter<string | typeof SynthesizeStream.FLUSH_SENTINEL>;
  private outputReader: ReadableStreamDefaultReader<
    SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM
  >;
  private logger = log();
  private inputClosed = false;

  constructor(tts: TTS) {
    this.#tts = tts;
    this.deferredInputStream = new DeferredReadableStream();

    this.inputWriter = this.input.writable.getWriter();
    this.inputReader = this.input.readable.getReader();
    this.outputWriter = this.output.writable.getWriter();

    const [outputStream, metricsStream] = this.output.readable.tee();
    this.outputReader = outputStream.getReader();
    this.metricsStream = metricsStream;

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
        if (done || value === SynthesizeStream.FLUSH_SENTINEL) {
          break;
        }
        this.inputWriter.write(value);
      }
    } catch (error) {
      this.logger.error(error, 'Error reading deferred input stream');
    } finally {
      reader.releaseLock();
      this.flush();
      this.endInput();
    }
  }

  protected async monitorMetrics() {
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

    const metricsReader = this.metricsStream.getReader();

    while (true) {
      const { done, value: audio } = await metricsReader.read();
      if (done || audio === SynthesizeStream.END_OF_STREAM) break;
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

  updateInputStream(text: ReadableStream<string>) {
    this.deferredInputStream.setSource(text);
  }

  /** Push a string of text to the TTS */
  /** @deprecated Use `updateInputStream` instead */
  pushText(text: string) {
    this.#metricsText += text;

    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputWriter.write(text);
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
    this.inputWriter.write(SynthesizeStream.FLUSH_SENTINEL);
  }

  /** Mark the input as ended and forbid additional pushes */
  endInput() {
    if (this.inputClosed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.inputClosed = true;
    this.inputWriter.close();
  }

  next(): Promise<IteratorResult<SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM>> {
    return this.outputReader.read().then(({ done, value }) => {
      if (done) {
        return { done: true, value: undefined };
      }
      return { done: false, value };
    });
  }

  /** Close both the input and output of the TTS stream */
  close() {
    if (!this.inputClosed) {
      this.inputWriter.close();
    }
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
  protected outputWriter: WritableStreamDefaultWriter<
    SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM
  >;
  protected closed = false;
  abstract label: string;
  #text: string;
  #tts: TTS;
  private output = new IdentityTransform<SynthesizedAudio>();
  private outputReader: ReadableStreamDefaultReader<SynthesizedAudio>;
  private metricsStream: ReadableStream<SynthesizedAudio>;

  constructor(text: string, tts: TTS) {
    this.#text = text;
    this.#tts = tts;

    this.outputWriter = this.output.writable.getWriter();
    const [outputStream, metricsStream] = this.output.readable.tee();
    this.outputReader = outputStream.getReader();
    this.metricsStream = metricsStream;

    this.monitorMetrics();
  }

  protected async monitorMetrics() {
    const startTime = process.hrtime.bigint();
    let audioDuration = 0;
    let ttfb: bigint | undefined;
    let requestId = '';

    const metricsReader = this.metricsStream.getReader();

    while (true) {
      const { done, value: audio } = await metricsReader.read();
      if (done) break;

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
    const { done, value } = await this.outputReader.read();
    if (done) {
      return { done: true, value: undefined };
    }
    return { done: false, value };
  }

  /** Close both the input and output of the TTS stream */
  close() {
    if (!this.closed) {
      this.outputWriter.close();
    }
    this.closed = true;
  }

  [Symbol.asyncIterator](): ChunkedStream {
    return this;
  }
}
