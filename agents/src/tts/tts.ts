// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import type { Span } from '@opentelemetry/api';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import type { TTSMetrics } from '../metrics/base.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { recordException, traceTypes, tracer } from '../telemetry/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, intervalForRetry } from '../types.js';
import { AsyncIterableQueue, delay, mergeFrames, startSoon, toError } from '../utils.js';
import type { TimedString } from '../voice/io.js';

/**
 * SynthesizedAudio is a packet of speech synthesis as returned by the TTS.
 */
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
  /**
   * Timed transcripts associated with this audio packet (word-level timestamps).
   */
  timedTranscripts?: TimedString[];
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
  // Whether this TTS supports aligned transcripts (word-level timestamps).
  alignedTranscript?: boolean;
}

export interface TTSError {
  type: 'tts_error';
  timestamp: number;
  label: string;
  error: Error;
  recoverable: boolean;
}

export type TTSCallbacks = {
  ['metrics_collected']: (metrics: TTSMetrics) => void;
  ['error']: (error: TTSError) => void;
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
  abstract synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream;

  /**
   * Returns a {@link SynthesizeStream} that can be used to push text and receive audio data
   *
   * @param options - Optional configuration including connection options
   */
  abstract stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream;

  async close(): Promise<void> {
    return;
  }
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
  protected connOptions: APIConnectOptions;
  protected abortController = new AbortController();

  private deferredInputStream: DeferredReadableStream<
    string | typeof SynthesizeStream.FLUSH_SENTINEL
  >;
  private logger = log();

  abstract label: string;

  #tts: TTS;
  #metricsPendingTexts: string[] = [];
  #metricsText = '';
  #monitorMetricsTask?: Promise<void>;
  #ttsRequestSpan?: Span;

  constructor(tts: TTS, connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS) {
    this.#tts = tts;
    this.connOptions = connOptions;
    this.deferredInputStream = new DeferredReadableStream();
    this.pumpInput();

    this.abortController.signal.addEventListener('abort', () => {
      this.deferredInputStream.detachSource();
      // TODO (AJS-36) clean this up when we refactor with streams
      if (!this.input.closed) this.input.close();
      if (!this.output.closed) this.output.close();
      this.closed = true;
    });

    // this is a hack to immitate asyncio.create_task so that mainTask
    // is run **after** the constructor has finished. Otherwise we get
    // runtime error when trying to access class variables in the
    // `run` method.
    startSoon(() => this.mainTask().finally(() => this.queue.close()));
  }

  private _mainTaskImpl = async (span: Span) => {
    this.#ttsRequestSpan = span;
    span.setAttributes({
      [traceTypes.ATTR_TTS_STREAMING]: true,
      [traceTypes.ATTR_TTS_LABEL]: this.#tts.label,
    });

    for (let i = 0; i < this.connOptions.maxRetry + 1; i++) {
      try {
        return await tracer.startActiveSpan(
          async (attemptSpan) => {
            attemptSpan.setAttribute(traceTypes.ATTR_RETRY_COUNT, i);
            try {
              return await this.run();
            } catch (error) {
              recordException(attemptSpan, toError(error));
              throw error;
            }
          },
          { name: 'tts_request_run' },
        );
      } catch (error) {
        if (error instanceof APIError) {
          const retryInterval = intervalForRetry(this.connOptions, i);

          if (this.connOptions.maxRetry === 0 || !error.retryable) {
            this.emitError({ error, recoverable: false });
            throw error;
          } else if (i === this.connOptions.maxRetry) {
            this.emitError({ error, recoverable: false });
            throw new APIConnectionError({
              message: `failed to generate TTS completion after ${this.connOptions.maxRetry + 1} attempts`,
              options: { retryable: false },
            });
          } else {
            // Don't emit error event for recoverable errors during retry loop
            // to avoid ERR_UNHANDLED_ERROR or premature session termination
            this.logger.warn(
              { tts: this.#tts.label, attempt: i + 1, error },
              `failed to synthesize speech, retrying in  ${retryInterval}s`,
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
  };

  private mainTask = async () =>
    tracer.startActiveSpan(async (span) => this._mainTaskImpl(span), {
      name: 'tts_request',
      endOnExit: false,
    });

  private emitError({ error, recoverable }: { error: Error; recoverable: boolean }) {
    this.#tts.emit('error', {
      type: 'tts_error',
      timestamp: Date.now(),
      label: this.#tts.label,
      error,
      recoverable,
    });
  }

  // NOTE(AJS-37): The implementation below uses an AsyncIterableQueue (`this.input`)
  // bridged from a DeferredReadableStream (`this.deferredInputStream`) rather than
  // consuming the stream directly.
  //
  // A full refactor to native Web Streams was considered but is currently deferred.
  // The primary reason is to maintain architectural parity with the Python SDK,
  // which is a key design goal for the project. This ensures a consistent developer
  // experience across both platforms.
  //
  // For more context, see the discussion in GitHub issue # 844.
  protected async pumpInput() {
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
    let audioDurationMs = 0;
    let ttfb: bigint = BigInt(-1);
    let requestId = '';

    const emit = () => {
      if (this.#metricsPendingTexts.length) {
        const text = this.#metricsPendingTexts.shift()!;
        const duration = process.hrtime.bigint() - startTime;
        const roundedAudioDurationMs = Math.round(audioDurationMs);
        const metrics: TTSMetrics = {
          type: 'tts_metrics',
          timestamp: Date.now(),
          requestId,
          ttfbMs: ttfb === BigInt(-1) ? -1 : Math.trunc(Number(ttfb / BigInt(1000000))),
          durationMs: Math.trunc(Number(duration / BigInt(1000000))),
          charactersCount: text.length,
          audioDurationMs: roundedAudioDurationMs,
          cancelled: this.abortController.signal.aborted,
          label: this.#tts.label,
          streamed: false,
        };
        if (this.#ttsRequestSpan) {
          this.#ttsRequestSpan.setAttribute(traceTypes.ATTR_TTS_METRICS, JSON.stringify(metrics));
        }
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
      audioDurationMs += (audio.frame.samplesPerChannel / audio.frame.sampleRate) * 1000;
      if (audio.final) {
        emit();
      }
    }

    if (requestId) {
      emit();
    }

    if (this.#ttsRequestSpan) {
      this.#ttsRequestSpan.end();
      this.#ttsRequestSpan = undefined;
    }
  }

  protected abstract run(): Promise<void>;

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

    if (this.input.closed || this.closed) {
      // Stream was aborted/closed, silently skip
      return;
    }

    this.input.put(text);
  }

  /** Flush the TTS, causing it to process all pending text */
  flush() {
    if (this.#metricsText) {
      this.#metricsPendingTexts.push(this.#metricsText);
      this.#metricsText = '';
    }

    if (this.input.closed || this.closed) {
      // Stream was aborted/closed, silently skip
      return;
    }

    this.input.put(SynthesizeStream.FLUSH_SENTINEL);
  }

  /** Mark the input as ended and forbid additional pushes */
  endInput() {
    this.flush();

    if (this.input.closed || this.closed) {
      // Stream was aborted/closed, silently skip
      return;
    }

    this.input.close();
  }

  next(): Promise<IteratorResult<SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM>> {
    return this.output.next();
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
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
  #ttsRequestSpan?: Span;
  private _connOptions: APIConnectOptions;
  private logger = log();

  protected abortController = new AbortController();

  constructor(
    text: string,
    tts: TTS,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal,
  ) {
    this.#text = text;
    this.#tts = tts;
    this._connOptions = connOptions;

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => this.abortController.abort(), { once: true });
    }

    this.monitorMetrics();

    // this is a hack to immitate asyncio.create_task so that mainTask
    // is run **after** the constructor has finished. Otherwise we get
    // runtime error when trying to access class variables in the
    // `run` method.
    Promise.resolve().then(() => this.mainTask().finally(() => this.queue.close()));
  }

  private _mainTaskImpl = async (span: Span) => {
    this.#ttsRequestSpan = span;
    span.setAttributes({
      [traceTypes.ATTR_TTS_STREAMING]: false,
      [traceTypes.ATTR_TTS_LABEL]: this.#tts.label,
    });

    for (let i = 0; i < this._connOptions.maxRetry + 1; i++) {
      try {
        return await tracer.startActiveSpan(
          async (attemptSpan) => {
            attemptSpan.setAttribute(traceTypes.ATTR_RETRY_COUNT, i);
            try {
              return await this.run();
            } catch (error) {
              recordException(attemptSpan, toError(error));
              throw error;
            }
          },
          { name: 'tts_request_run' },
        );
      } catch (error) {
        if (error instanceof APIError) {
          const retryInterval = intervalForRetry(this._connOptions, i);

          if (this._connOptions.maxRetry === 0 || !error.retryable) {
            this.emitError({ error, recoverable: false });
            throw error;
          } else if (i === this._connOptions.maxRetry) {
            this.emitError({ error, recoverable: false });
            throw new APIConnectionError({
              message: `failed to generate TTS completion after ${this._connOptions.maxRetry + 1} attempts`,
              options: { retryable: false },
            });
          } else {
            // Don't emit error event for recoverable errors during retry loop
            // to avoid ERR_UNHANDLED_ERROR or premature session termination
            this.logger.warn(
              { tts: this.#tts.label, attempt: i + 1, error },
              `failed to generate TTS completion, retrying in ${retryInterval}s`,
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
  };

  private async mainTask() {
    return tracer.startActiveSpan(async (span) => this._mainTaskImpl(span), {
      name: 'tts_request',
      endOnExit: false,
    });
  }

  private emitError({ error, recoverable }: { error: Error; recoverable: boolean }) {
    this.#tts.emit('error', {
      type: 'tts_error',
      timestamp: Date.now(),
      label: this.#tts.label,
      error,
      recoverable,
    });
  }

  protected abstract run(): Promise<void>;

  get inputText(): string {
    return this.#text;
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  protected async monitorMetrics() {
    const startTime = process.hrtime.bigint();
    let audioDurationMs = 0;
    let ttfb: bigint = BigInt(-1);
    let requestId = '';

    for await (const audio of this.queue) {
      this.output.put(audio);
      requestId = audio.requestId;
      if (ttfb === BigInt(-1)) {
        ttfb = process.hrtime.bigint() - startTime;
      }
      audioDurationMs += (audio.frame.samplesPerChannel / audio.frame.sampleRate) * 1000;
    }
    this.output.close();

    const duration = process.hrtime.bigint() - startTime;
    const metrics: TTSMetrics = {
      type: 'tts_metrics',
      timestamp: Date.now(),
      requestId,
      ttfbMs: ttfb === BigInt(-1) ? -1 : Math.trunc(Number(ttfb / BigInt(1000000))),
      durationMs: Math.trunc(Number(duration / BigInt(1000000))),
      charactersCount: this.#text.length,
      audioDurationMs: Math.round(audioDurationMs),
      cancelled: false, // TODO(AJS-186): support ChunkedStream with 1.0 - add this.abortController.signal.aborted here
      label: this.#tts.label,
      streamed: false,
    };

    if (this.#ttsRequestSpan) {
      this.#ttsRequestSpan.setAttribute(traceTypes.ATTR_TTS_METRICS, JSON.stringify(metrics));
      this.#ttsRequestSpan.end();
      this.#ttsRequestSpan = undefined;
    }

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
    if (!this.queue.closed) this.queue.close();
    if (!this.output.closed) this.output.close();
    if (!this.abortController.signal.aborted) this.abortController.abort();
    this.closed = true;
  }

  [Symbol.asyncIterator](): ChunkedStream {
    return this;
  }
}
