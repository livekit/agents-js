// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio EOT (end-of-turn) detector base, the per-window inference stream, and
 * the transport interface that concrete cloud/local backends implement.
 *
 * Concrete implementations live in `agents/src/inference/eot/`.
 *
 * Port of Python `livekit.agents.voice.turn.audio`.
 */
import type { AudioFrame } from '@livekit/rtc-node';
import { AudioResampler, AudioResamplerQuality } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import type { LanguageCode } from '../../language.js';
import { log } from '../../log.js';
import type { EOTInferenceMetrics } from '../../metrics/base.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { Future, Task, cancelAndWait, shortuuid } from '../../utils.js';
import type { ThresholdOptions, TurnDetectorModel } from './languages.js';

export const DEFAULT_SAMPLE_RATE = 16000;
export const MIN_SILENCE_DURATION_MS = 200;

/**
 * Options shared by the audio EOT stream and every transport.
 *
 * Cloud-only transport concerns (base URL, credentials, conn options)
 * live on a separate options class owned by the cloud transport.
 */
export interface BaseStreamingTurnDetectorOptions {
  sampleRate: number;
  thresholds: ThresholdOptions;
}

/**
 * Event emitted on each EOT prediction.
 */
export interface TurnDetectionEvent {
  type: 'eot_prediction';
  endOfTurnProbability: number;
  /** Wall-clock time when the prediction landed (milliseconds since epoch). */
  lastSpeakingTimeMs: number;
  /** Latest input-audio creation time → prediction receive time (ms). */
  detectionDelay?: number;
  /** Server-side model inference time (ms). */
  inferenceDuration?: number;
}

/**
 * Sentinel value carried alongside flush requests. Signals a turn boundary
 * to the transport so it can clear its buffered audio.
 */
export interface FlushSentinel {
  readonly kind: 'flush';
  reason?: string;
}

export function isFlushSentinel(value: unknown): value is FlushSentinel {
  return typeof value === 'object' && value !== null && (value as FlushSentinel).kind === 'flush';
}

/**
 * Transport adapter for `BaseStreamingTurnDetectorStream` — owns the I/O (WebSocket
 * session, in-process predict, etc.). The stream calls these methods
 * directly; transports report predictions back via
 * `stream._resolvePrediction(requestId, probability, ...)`.
 */
export interface StreamingTurnDetectionTransport {
  attach(stream: BaseStreamingTurnDetectorStream): void;
  run(): Promise<void>;
  runInference(requestId: string): void;
  pushFrame(frame: AudioFrame): Promise<void>;
  flush(sentinel: FlushSentinel): Promise<void>;
  detach(): void;
}

export type BaseStreamingTurnDetectorCallbacks = {
  metrics_collected: (metrics: EOTInferenceMetrics) => void;
};

/**
 * Abstract base for audio EOT detectors. Holds the threshold table and
 * provides `stream()` to create a per-turn FSM instance.
 *
 * Subclasses (`TurnDetector` in `inference/eot/detector.ts`) wire up
 * concrete transports.
 */
export abstract class BaseStreamingTurnDetector extends (EventEmitter as new () => TypedEmitter<BaseStreamingTurnDetectorCallbacks>) {
  protected _opts: BaseStreamingTurnDetectorOptions;
  /**
   * Active streams the detector tracks for bulk teardown via `aclose()`.
   * `Set` rather than `WeakSet` because we need iteration; each stream
   * removes itself on its own `aclose` (see `BaseStreamingTurnDetectorStream.aclose`)
   * so the strong refs are released without requiring the caller to call
   * `detector.aclose()`.
   */
  protected _streams: Set<BaseStreamingTurnDetectorStream> = new Set();

  constructor(opts: BaseStreamingTurnDetectorOptions) {
    super();
    this._opts = opts;
  }

  /** @internal Stream lifecycle hook — called by the stream itself on close. */
  _unregisterStream(stream: BaseStreamingTurnDetectorStream): void {
    this._streams.delete(stream);
  }

  abstract get model(): TurnDetectorModel;

  get provider(): string {
    return 'livekit';
  }

  /** Most-recent materialized threshold map (after any cloud→local fallback
   * rescale or server-default adoption). */
  get thresholds(): Readonly<Record<string, number>> {
    return this._opts.thresholds.thresholds;
  }

  /** Threshold below which the detector treats the prediction as "unlikely
   * to be end-of-turn". Returns `undefined` when the language isn't covered. */
  async unlikelyThreshold(language: LanguageCode | undefined): Promise<number | undefined> {
    return this._opts.thresholds.lookup(language);
  }

  async supportsLanguage(language: LanguageCode | undefined): Promise<boolean> {
    return this._opts.thresholds.supports(language);
  }

  abstract stream(): BaseStreamingTurnDetectorStream;

  async aclose(): Promise<void> {
    const streams = Array.from(this._streams);
    this._streams.clear();
    await Promise.allSettled(streams.map((s) => s.aclose()));
  }
}

/**
 * Per-window inference stream. A thin transport-facing surface: per-request
 * state is one `(requestId, requestFut)` pair.
 *
 * - `predict()` starts a request and returns its future, superseding any
 *   previous request.
 * - the transport's single prediction completes the request by resolving the
 *   future via `_resolvePrediction`.
 * - `cancelInference()` / `flush(reason)` close a pending request, resolving
 *   its future with a default event so waiters never hang.
 *
 * All policy (when to start a request, await timeout, turn commits) lives in
 * `AudioRecognition`.
 */
export class SwapAbortError extends Error {
  constructor() {
    super('__swap__');
    this.name = 'SwapAbortError';
  }
}

export class BaseStreamingTurnDetectorStream {
  protected _detector: BaseStreamingTurnDetector;
  protected _opts: BaseStreamingTurnDetectorOptions;
  protected _transport: StreamingTurnDetectionTransport;

  private _audioInputSampleRate: number | undefined;
  private _audioInputNumChannels: number | undefined;
  private _audioResampler: AudioResampler | undefined;
  private _audioChannel: StreamChannel<AudioFrame | FlushSentinel> = createStreamChannel();

  /** Id of the in-flight inference request, or `undefined` when idle. */
  protected _requestId: string | undefined;
  /** Future for the in-flight request; resolves to the prediction event (or
   * a default event when the request is cancelled / flushed). */
  protected _requestFut: Future<TurnDetectionEvent> | undefined;

  protected _mainTask: Task<void>;
  protected _logger = log();
  /**
   * Aborted whenever the main loop needs to retry on a new transport (e.g.
   * fallback). The base FSM also aborts it from `aclose()` so idle
   * transports that are awaiting forever can be unstuck. Listeners check
   * `signal.aborted` and surface a sentinel rejection so the `_run` loop
   * can decide whether to continue or exit.
   */
  protected _swapController = new AbortController();

  constructor(args: {
    detector: BaseStreamingTurnDetector;
    opts: BaseStreamingTurnDetectorOptions;
    transport: StreamingTurnDetectionTransport;
  }) {
    this._detector = args.detector;
    this._opts = args.opts;
    this._transport = args.transport;
    this._transport.attach(this);

    this._mainTask = Task.from((controller) => this._mainTaskBody(controller));
  }

  // region: _TurnDetector protocol proxies

  get model(): TurnDetectorModel {
    return this._detector.model;
  }

  get provider(): string {
    return this._detector.provider;
  }

  /** @internal Shared threshold resolver — the cloud transport reads it to
   * adopt the server-sent defaults from `SessionCreated`. */
  get thresholdsOptions(): ThresholdOptions {
    return this._opts.thresholds;
  }

  async unlikelyThreshold(language: LanguageCode | undefined): Promise<number | undefined> {
    return this._opts.thresholds.lookup(language);
  }

  async supportsLanguage(language: LanguageCode | undefined): Promise<boolean> {
    return this._opts.thresholds.supports(language);
  }

  // endregion

  // region: inference requests

  /** Start a new inference request and return its future, superseding any
   * previous request. */
  predict(): Future<TurnDetectionEvent> {
    if (this._audioChannel.closed) {
      const fut = new Future<TurnDetectionEvent>();
      fut.resolve(BaseStreamingTurnDetectorStream._defaultEvent(1.0));
      return fut;
    }

    this.cancelInference(); // supersede any previous request
    const fut = new Future<TurnDetectionEvent>();
    this._requestId = shortuuid('turn_request_');
    this._requestFut = fut;
    // A transport may resolve synchronously (e.g. the local no-executor path
    // defaults to 1.0 inline), which clears `_requestFut` via
    // `_resolvePrediction`. Hold a local reference so we still return the
    // resolved future rather than `undefined`.
    this._transport.runInference(this._requestId);
    return fut;
  }

  /** Close the current inference request (new speech, turn boundary,
   * prediction timeout, mode change) and fall back if needed. */
  cancelInference(opts: { timedOut?: boolean } = {}): void {
    if (this._requestId !== undefined) {
      const fut = this._requestFut;
      this._requestId = undefined;
      this._requestFut = undefined;
      if (fut !== undefined && !fut.done) {
        fut.resolve(BaseStreamingTurnDetectorStream._defaultEvent(0.0));
      }
    }

    // trigger fallback immediately (the subclass timeout hook checks the
    // model + signals the transport swap; the base hook is a no-op).
    if (opts.timedOut) {
      this._onPredictTimeout();
    }
  }

  flush(reason?: string): void {
    // Idempotent: a second call sends another sentinel that transports
    // treat as a no-op (cloud: redundant session_flush; local: empty trim).
    if (this._audioChannel.closed) {
      return;
    }
    for (const resampled of this._flushAudioResampler()) {
      void this._audioChannel.write(resampled);
    }
    const sentinel: FlushSentinel = {
      kind: 'flush',
      reason,
    };
    void this._audioChannel.write(sentinel);
    this.cancelInference();
  }

  protected static _defaultEvent(probability: number): TurnDetectionEvent {
    return {
      type: 'eot_prediction',
      endOfTurnProbability: probability,
      lastSpeakingTimeMs: Date.now(),
    };
  }

  // endregion

  // region: audio ingress

  pushAudio(frame: AudioFrame): void {
    if (this._audioChannel.closed) {
      return;
    }
    for (const resampled of this._resampleAudioFrame(frame)) {
      void this._audioChannel.write(resampled);
    }
  }

  endInput(): void {
    this.flush();
    void this._audioChannel.close();
  }

  private _resampleAudioFrame(frame: AudioFrame): AudioFrame[] {
    if (this._audioInputSampleRate === undefined || this._audioInputNumChannels === undefined) {
      this._audioInputSampleRate = frame.sampleRate;
      this._audioInputNumChannels = frame.channels;
      if (this._audioInputSampleRate !== this._opts.sampleRate) {
        this._audioResampler = new AudioResampler(
          this._audioInputSampleRate,
          this._opts.sampleRate,
          this._audioInputNumChannels,
          AudioResamplerQuality.QUICK,
        );
      }
    } else if (
      frame.sampleRate !== this._audioInputSampleRate ||
      frame.channels !== this._audioInputNumChannels
    ) {
      this._logger.error(
        {
          sampleRate: frame.sampleRate,
          expectedSampleRate: this._audioInputSampleRate,
          numChannels: frame.channels,
          expectedNumChannels: this._audioInputNumChannels,
        },
        'a frame with different audio format was already pushed',
      );
      return [];
    }
    if (this._audioResampler === undefined) {
      return [frame];
    }
    return this._audioResampler.push(frame);
  }

  private _flushAudioResampler(): AudioFrame[] {
    const frames = this._audioResampler?.flush() ?? [];
    this._resetAudioResampler();
    return frames;
  }

  private _resetAudioResampler(): void {
    this._audioResampler = undefined;
    this._audioInputSampleRate = undefined;
    this._audioInputNumChannels = undefined;
  }

  // endregion

  // region: results

  /**
   * Accept a prediction from a transport. A stale response (request id
   * mismatch) is ignored; otherwise the in-flight future resolves with the
   * full `TurnDetectionEvent` and the request completes.
   */
  _resolvePrediction(
    requestId: string,
    probability: number,
    opts: { inferenceDuration?: number; detectionDelay?: number } = {},
  ): void {
    // Drop predictions that land after teardown — an in-flight transport
    // predict can resolve after `aclose` closed the channels.
    if (this._closing) {
      return;
    }
    if (requestId !== this._requestId) {
      return;
    }
    const fut = this._requestFut;
    this._requestId = undefined;
    this._requestFut = undefined;
    if (fut !== undefined && !fut.done) {
      fut.resolve({
        type: 'eot_prediction',
        endOfTurnProbability: probability,
        lastSpeakingTimeMs: Date.now(),
        detectionDelay: opts.detectionDelay,
        inferenceDuration: opts.inferenceDuration,
      });
    }
  }

  // endregion

  // region: teardown

  /**
   * Synchronously release this stream's registration on its owning detector,
   * so a replacement stream can be created before this one's async teardown
   * finishes. Base is a no-op; detectors that enforce single-stream ownership
   * override it. Idempotent.
   */
  detach(): void {
    return;
  }

  async aclose(): Promise<void> {
    this.endInput(); // the flush inside closes the in-flight request
    this._closing = true;
    this._swapController.abort();
    await cancelAndWait([this._mainTask]);
    this.cancelInference(); // defensive, normally a no-op
    // Drop our strong reference on the parent detector so callers that
    // forget `detector.aclose()` don't leak the stream graph.
    this._detector._unregisterStream(this);
  }

  /** True once `aclose()` has been called. The `_run` loop uses this to
   * distinguish swap-aborts (continue with new transport) from teardown
   * aborts (exit). */
  protected _closing = false;

  // endregion

  // region: main task scaffolding

  private async _mainTaskBody(_controller: AbortController): Promise<void> {
    await this._run();
  }

  /**
   * Drain the shared audio channel into the current transport.
   *
   * The audio channel exposes a single `ReadableStream` (one underlying
   * `transform.readable`), so only one reader may hold its lock at a time.
   * When `signal` aborts (a transport being swapped out — e.g. cloud→local
   * fallback — fires it via `detach()`), we release the reader lock right
   * away: on a pending `read()` this rejects that read and frees the lock so
   * the swapped-in transport's `_drainAudioChannel` can re-acquire it.
   * Without this an orphaned drain would hold the lock forever and the next
   * `getReader()` would throw "ReadableStream is locked".
   */
  async _drainAudioChannel(signal?: AbortSignal): Promise<void> {
    const stream = this._audioChannel.stream();
    const reader = stream.getReader();
    const release = () => {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    };
    if (signal?.aborted) {
      release();
      return;
    }
    signal?.addEventListener('abort', release, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (isFlushSentinel(value)) {
          await this._transport.flush(value);
        } else {
          await this._transport.pushFrame(value);
        }
      }
    } catch (err) {
      // The pending `read()` rejects when `release()` runs on abort — a clean
      // swap-driven exit, not a drain failure.
      if (signal?.aborted) return;
      throw err;
    } finally {
      signal?.removeEventListener('abort', release);
      release();
    }
  }

  // endregion

  // region: subclass hooks

  /** Default: hand control to the transport. Subclasses override for
   * cross-transport orchestration (e.g. cloud→local fallback). */
  protected async _run(): Promise<void> {
    await this._raceWithSwap(this._transport.run());
  }

  /**
   * Race `inner` against `_swapController.signal`. If the signal aborts
   * while `inner` is still pending, throw a `SwapAbortError` so the
   * subclass loop can decide whether to continue or exit. Resets the
   * controller after a swap-abort so subsequent races have a fresh signal.
   *
   * `aclose()` aborts during teardown — subclasses observe `_closing` to
   * exit cleanly instead of looping.
   */
  protected async _raceWithSwap<T>(inner: Promise<T>): Promise<T> {
    const signal = this._swapController.signal;
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new SwapAbortError());
        return;
      }
      signal.addEventListener('abort', () => reject(new SwapAbortError()), { once: true });
    });
    try {
      return await Promise.race([inner, abortPromise]);
    } finally {
      if (signal.aborted) {
        // Reset for the next iteration of the subclass loop.
        this._swapController = new AbortController();
      }
    }
  }

  /** @internal Wake up an idle transport so the main loop can pick up a
   * new one after fallback. Subclasses call this from their swap logic. */
  protected _signalSwap(): void {
    this._swapController.abort();
  }

  /** `predictEndOfTurn` timed out. Subclasses may override to react (e.g.
   * promote local on cloud timeout). */
  protected _onPredictTimeout(): void {
    return;
  }

  // endregion
}
