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
import { AsyncIterableQueue, mergeFrames } from '../utils.js';

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

export type TTSCallbacks = {
  ['metrics_collected']: (metrics: TTSMetrics) => void;
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
  protected input = new AsyncIterableQueue<string | typeof SynthesizeStream.FLUSH_SENTINEL>();
  protected queue = new AsyncIterableQueue<
    SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM
  >();
  protected output = new AsyncIterableQueue<
    SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM
  >();
  protected closed = false;
  abstract label: string;
  #tts: TTS;
  #metricsPendingTexts: string[] = [];
  #metricsText = '';
  #monitorMetricsTask?: Promise<void>;
  protected abortController = new AbortController();

  private deferredInputStream: DeferredReadableStream<
    string | typeof SynthesizeStream.FLUSH_SENTINEL
  >;
  private logger = log();

  constructor(tts: TTS) {
    this.#tts = tts;
    this.deferredInputStream = new DeferredReadableStream();
    this.mainTask();
    this.abortController.signal.addEventListener('abort', () => {
      this.deferredInputStream.detachSource();
      // TODO (AJS-36) clean this up when we refactor with streams
      this.input.close();
      this.output.close();
      this.closed = true;
    });
  }

  // TODO(AJS-37) Remove when refactoring TTS to use streams
  protected async mainTask() {
    const reader = this.deferredInputStream.stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || value === SynthesizeStream.FLUSH_SENTINEL) {
          break;
        }
        this.pushText(value);
      }
      this.endInput();
    } catch (error) {
      this.logger.error(error, 'Error reading deferred input stream');
    } finally {
      reader.releaseLock();
      // Ensure output is closed when the stream ends
      if (!this.#monitorMetricsTask) {
        // No text was received, close the output directly
        this.output.close();
      }
    }
  }

  protected async monitorMetrics() {
    const startTime = process.hrtime.bigint();
    let audioDuration = 0;
    let ttfb: bigint = BigInt(-1);
    let requestId = '';

    const emit = () => {
      if (this.#metricsPendingTexts.length) {
        const text = this.#metricsPendingTexts.shift()!;
        const duration = process.hrtime.bigint() - startTime;
        const metrics: TTSMetrics = {
          type: 'tts_metrics',
          timestamp: Date.now(),
          requestId,
          ttfb: ttfb === BigInt(-1) ? -1 : Math.trunc(Number(ttfb / BigInt(1000000))),
          duration: Math.trunc(Number(duration / BigInt(1000000))),
          charactersCount: text.length,
          audioDuration,
          cancelled: this.abortController.signal.aborted,
          label: this.#tts.label,
          streamed: false,
        };
        this.#tts.emit('metrics_collected', metrics);
      }
    };

    for await (const audio of this.queue) {
      if (this.abortController.signal.aborted) {
        break;
      }
      this.output.put(audio);
      if (audio === SynthesizeStream.END_OF_STREAM) continue;
      requestId = audio.requestId;
      if (ttfb === BigInt(-1)) {
        ttfb = process.hrtime.bigint() - startTime;
      }
      // TODO(AJS-102): use frame.durationMs once available in rtc-node
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
    if (!this.#monitorMetricsTask) {
      this.#monitorMetricsTask = this.monitorMetrics();
      // Close output when metrics task completes
      this.#monitorMetricsTask.finally(() => this.output.close());
    }
    this.#metricsText += text;

    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(text);
  }

  /** Flush the TTS, causing it to process all pending text */
  flush() {
    if (this.#metricsText) {
      this.#metricsPendingTexts.push(this.#metricsText);
      this.#metricsText = '';
    }
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.put(SynthesizeStream.FLUSH_SENTINEL);
  }

  /** Mark the input as ended and forbid additional pushes */
  endInput() {
    this.flush();
    if (this.input.closed) {
      throw new Error('Input is closed');
    }
    if (this.closed) {
      throw new Error('Stream is closed');
    }
    this.input.close();
  }

  next(): Promise<IteratorResult<SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM>> {
    return this.output.next();
  }

  /** Close both the input and output of the TTS stream */
  close() {
    this.abortController.abort();
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
  protected queue = new AsyncIterableQueue<SynthesizedAudio>();
  protected output = new AsyncIterableQueue<SynthesizedAudio>();
  protected closed = false;
  abstract label: string;
  #text: string;
  #tts: TTS;

  constructor(text: string, tts: TTS) {
    this.#text = text;
    this.#tts = tts;

    this.monitorMetrics();
  }

  protected async monitorMetrics() {
    const startTime = process.hrtime.bigint();
    let audioDuration = 0;
    let ttfb: bigint = BigInt(-1);
    let requestId = '';

    for await (const audio of this.queue) {
      this.output.put(audio);
      requestId = audio.requestId;
      if (!ttfb) {
        ttfb = process.hrtime.bigint() - startTime;
      }
      audioDuration += audio.frame.samplesPerChannel / audio.frame.sampleRate;
    }
    this.output.close();

    const duration = process.hrtime.bigint() - startTime;
    const metrics: TTSMetrics = {
      type: 'tts_metrics',
      timestamp: Date.now(),
      requestId,
      ttfb: ttfb === BigInt(-1) ? -1 : Math.trunc(Number(ttfb / BigInt(1000000))),
      duration: Math.trunc(Number(duration / BigInt(1000000))),
      charactersCount: this.#text.length,
      audioDuration,
      cancelled: false, // TODO(AJS-186): support ChunkedStream with 1.0 - add this.abortController.signal.aborted here
      label: this.#tts.label,
      streamed: false,
    };
    this.#tts.emit('metrics_collected', metrics);
  }

  /** Collect every frame into one in a single call */
  async collect(): Promise<AudioFrame> {
    const frames = [];
    for await (const event of this) {
      frames.push(event.frame);
    }
    return mergeFrames(frames);
  }

  next(): Promise<IteratorResult<SynthesizedAudio>> {
    return this.output.next();
  }

  /** Close both the input and output of the TTS stream */
  close() {
    this.queue.close();
    this.output.close();
    this.closed = true;
  }

  [Symbol.asyncIterator](): ChunkedStream {
    return this;
  }
}
