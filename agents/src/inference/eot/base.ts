// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio EOT (end-of-turn) detector base, stream state machine, and the
 * transport interface that concrete cloud/local backends implement.
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
import type { ChatContext } from '../../llm/chat_context.js';
import { log } from '../../log.js';
import type { EOTInferenceMetrics } from '../../metrics/base.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { Future, Task, cancelAndWait, shortuuid } from '../../utils.js';
import type { ThresholdOptions, TurnDetectorModel } from './languages.js';

export const DEFAULT_SAMPLE_RATE = 16000;
export const MIN_SILENCE_DURATION_MS = 200;

export enum Status {
  IDLE = 'idle',
  ACTIVE = 'active',
}

/**
 * Options shared by the audio EOT stream and every transport.
 *
 * Cloud-only transport concerns (base URL, credentials, conn options)
 * live on a separate options class owned by the cloud transport.
 */
export interface TurnDetectorOptions {
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
 * Sentinel value carried alongside flush requests. Transports use
 * `keepTailMs` to optionally retain trailing audio for the next turn.
 */
export interface FlushSentinel {
  readonly kind: 'flush';
  reason?: string;
  keepTailMs: number;
}

export function isFlushSentinel(value: unknown): value is FlushSentinel {
  return typeof value === 'object' && value !== null && (value as FlushSentinel).kind === 'flush';
}

/**
 * Transport adapter for `AudioTurnDetectorStream` — owns the I/O (WebSocket
 * session, in-process predict, etc.). The stream calls these methods
 * directly; transports report predictions back via
 * `stream._handlePrediction(requestId, probability, ...)`.
 */
export interface AudioTurnDetectionTransport {
  attach(stream: AudioTurnDetectorStream): void;
  run(): Promise<void>;
  startInference(requestId: string): void;
  pushFrame(frame: AudioFrame): Promise<void>;
  flush(sentinel: FlushSentinel): Promise<void>;
  stopInference(reason?: string): void;
  detach(): void;
}

export type AudioTurnDetectorCallbacks = {
  metrics_collected: (metrics: EOTInferenceMetrics) => void;
};

/**
 * Abstract base for audio EOT detectors. Holds the threshold table and
 * provides `stream()` to create a per-turn FSM instance.
 *
 * Subclasses (`AudioTurnDetector` in `inference/eot/detector.ts`) wire up
 * concrete transports.
 */
export abstract class AudioTurnDetector extends (EventEmitter as new () => TypedEmitter<AudioTurnDetectorCallbacks>) {
  protected _opts: TurnDetectorOptions;
  /**
   * Active streams the detector tracks for bulk teardown via `aclose()`.
   * `Set` rather than `WeakSet` because we need iteration; each stream
   * removes itself on its own `aclose` (see `AudioTurnDetectorStream.aclose`)
   * so the strong refs are released without requiring the caller to call
   * `detector.aclose()`.
   */
  protected _streams: Set<AudioTurnDetectorStream> = new Set();

  constructor(opts: TurnDetectorOptions) {
    super();
    this._opts = opts;
  }

  /** @internal Stream lifecycle hook — called by the stream itself on close. */
  _unregisterStream(stream: AudioTurnDetectorStream): void {
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

  abstract stream(): AudioTurnDetectorStream;

  async aclose(): Promise<void> {
    const streams = Array.from(this._streams);
    this._streams.clear();
    await Promise.allSettled(streams.map((s) => s.aclose()));
  }
}

/**
 * Per-turn FSM:
 *
 * - `warmup()` opens an inference window (transport.startInference).
 * - `activate(trigger)` flips IDLE→ACTIVE; commits early if a confident
 *   prediction already resolved during warmup.
 * - `deactivate(trigger)` clears the request id, resolves the in-flight
 *   future with 0.0, calls transport.stopInference.
 * - `flush(reason, keepTailMs)` deactivates and signals turn boundary to
 *   the transport via a `FlushSentinel`. Clears the cached prediction so
 *   it can't leak into the next turn.
 * - `predictEndOfTurn(chatCtx?, { timeoutMs })` returns a probability,
 *   defaulting to 1.0 on timeout.
 */
export class SwapAbortError extends Error {
  constructor() {
    super('__swap__');
    this.name = 'SwapAbortError';
  }
}

export class AudioTurnDetectorStream {
  protected _detector: AudioTurnDetector;
  protected _opts: TurnDetectorOptions;
  protected _transport: AudioTurnDetectionTransport;

  private _audioInputSampleRate: number | undefined;
  private _audioInputNumChannels: number | undefined;
  private _audioResampler: AudioResampler | undefined;
  private _audioChannel: StreamChannel<AudioFrame | FlushSentinel> = createStreamChannel();

  protected _status: Status = Status.IDLE;
  protected _preemptiveRequestId: string | undefined;
  protected _preemptiveRequestFut: Future<number> | undefined;
  /**
   * Latest resolved prediction in the current inference window. Cleared
   * when a new window starts (next warmup) or on commit (flush). Lets
   * `predictEndOfTurn` return immediately when a prediction is already
   * in hand.
   */
  protected _lastPrediction: TurnDetectionEvent | undefined;
  /**
   * Most recent detected language, pushed by `AudioRecognition` on each STT
   * transcript. Used by the inline early-deactivation check (`_isLikely`) to
   * resolve the per-language unlikely-EOT threshold.
   */
  protected _lastLanguage: LanguageCode | undefined;
  /**
   * True between VAD start-of-speech (when `deactivate('vad sos')` re-arms it)
   * and the next `flush()` — i.e. a user turn is open and `predictEndOfTurn`
   * should run. When false, predict short-circuits to a positive default (the
   * audio EOT model has already committed; an STT final arriving after has
   * nothing fresh to evaluate). Initialized true so the first turn isn't
   * gated before any flush.
   */
  protected _userTurnStarted = true;
  /** Warn once per stream when predict is called after a commit. */
  protected _latePredictWarned = false;

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
    detector: AudioTurnDetector;
    opts: TurnDetectorOptions;
    transport: AudioTurnDetectionTransport;
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

  /**
   * Record the most recent detected language so the inline early-deactivation
   * check can resolve the unlikely-EOT threshold. Pushed by `AudioRecognition`
   * on each STT transcript.
   */
  updateLanguage(language: LanguageCode | undefined): void {
    this._lastLanguage = language;
  }

  /**
   * A prediction at or above `unlikelyThreshold` is no longer "unlikely" — it's
   * a confident end-of-turn. Mirrors that method's `undefined → "en"` fallback:
   * an unknown language still gets the English threshold; an explicitly
   * unsupported code misses the table and is never treated as likely.
   */
  protected _isLikely(probability: number): boolean {
    const threshold = this._opts.thresholds.lookup(this._lastLanguage);
    return threshold !== undefined && probability >= threshold;
  }

  // endregion

  // region: state machine

  get isActive(): boolean {
    return this._status === Status.ACTIVE;
  }

  get isInferenceRunning(): boolean {
    return this._preemptiveRequestId !== undefined;
  }

  get preemptiveRequestId(): string | undefined {
    return this._preemptiveRequestId;
  }

  get status(): Status {
    return this._status;
  }

  get lastPrediction(): TurnDetectionEvent | undefined {
    return this._lastPrediction;
  }

  /** Start an inference window if one isn't already open. Returns the
   * in-flight future. Idempotent. */
  warmup(): Future<number> {
    if (this._preemptiveRequestId === undefined) {
      const requestId = shortuuid('turn_request_');
      this._preemptiveRequestId = requestId;
      this._preemptiveRequestFut = new Future<number>();
      // New inference window — drop any cached prediction from the previous
      // window so `predictEndOfTurn` won't return stale.
      this._lastPrediction = undefined;
      this._transport.startInference(requestId);
    }
    if (this._preemptiveRequestFut === undefined) {
      throw new Error('eot detection warmup failed, no request future');
    }
    return this._preemptiveRequestFut;
  }

  activate(_trigger?: string): void {
    if (this._status === Status.ACTIVE) {
      return;
    }
    if (this._preemptiveRequestId === undefined) {
      this._logger.trace(
        'eot detector not warmed up before activation, likely due to overlapping speech',
      );
      this.warmup();
    }
    this._status = Status.ACTIVE;
    // A prediction may have resolved during the preemptive warmup window,
    // before activation. We deliberately hold off acting on the threshold
    // until now: a confident EOT only commits once VAD confirms end-of-speech
    // (the trigger that calls `activate`).
    if (
      this._lastPrediction !== undefined &&
      this._isLikely(this._lastPrediction.endOfTurnProbability)
    ) {
      this.deactivate('positive eou prediction');
    }
  }

  deactivate(trigger?: string): void {
    // Mirror Python: clear the "turn committed" guard at the top so a VAD
    // start-of-speech (which calls `deactivate('vad sos')`) re-arms the
    // user turn even if the FSM was already idle.
    this._userTurnStarted = true;
    if (this._preemptiveRequestId === undefined && this._status === Status.IDLE) {
      return;
    }
    this._preemptiveRequestId = undefined;
    if (this._preemptiveRequestFut !== undefined) {
      if (!this._preemptiveRequestFut.done) {
        this._preemptiveRequestFut.resolve(0.0);
      }
      this._preemptiveRequestFut = undefined;
    }
    this._status = Status.IDLE;
    this._transport.stopInference(trigger);
  }

  flush(reason?: string, opts: { keepTailMs?: number } = {}): void {
    if (this._audioChannel.closed) {
      return;
    }
    const keepTailMs = opts.keepTailMs ?? 0;
    for (const resampled of this._flushAudioResampler()) {
      void this._audioChannel.write(resampled);
    }
    const sentinel: FlushSentinel = {
      kind: 'flush',
      reason,
      keepTailMs,
    };
    void this._audioChannel.write(sentinel);
    // Turn boundary — the cached prediction belongs to the turn we just
    // closed and must not leak into the next one.
    this._lastPrediction = undefined;
    this.deactivate(reason);
    // Close the user turn AFTER deactivate (which re-arms the guard on its
    // way out): until the next VAD start-of-speech calls `deactivate('vad sos')`
    // to flip it back on, `predictEndOfTurn` short-circuits.
    this._userTurnStarted = false;
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
   * Accept a prediction from a transport. The stream owns dedup (by
   * requestId), future resolution, and the inline early-deactivate.
   */
  _handlePrediction(
    requestId: string,
    probability: number,
    opts: { inferenceDuration?: number; detectionDelay?: number } = {},
  ): void {
    // Drop predictions that land after teardown — an in-flight transport
    // predict can resolve after `aclose` closed the channels.
    if (this._closing) {
      return;
    }
    if (requestId !== this._preemptiveRequestId) {
      return;
    }
    if (this._preemptiveRequestFut !== undefined && !this._preemptiveRequestFut.done) {
      this._preemptiveRequestFut.resolve(probability);
    }
    const event: TurnDetectionEvent = {
      type: 'eot_prediction',
      endOfTurnProbability: probability,
      lastSpeakingTimeMs: Date.now(),
      detectionDelay: opts.detectionDelay,
      inferenceDuration: opts.inferenceDuration,
    };
    this._lastPrediction = event;
    // Early-deactivate: stop inference as soon as a confident EOT lands so a
    // later intra-speech silence can warm up a fresh window. Only while active
    // — predictions during preemptive warmup are cached and re-checked in
    // `activate()`. `deactivate` just sends a non-blocking `stopInference`, so
    // calling it inline from the transport's prediction callback is safe (no
    // reentrant await).
    if (this.isActive && this._isLikely(probability)) {
      this.deactivate('positive eou prediction');
    }
  }

  /**
   * Run a warmup inference and wait for a prediction within `timeoutMs`.
   *
   * Returns the cached prediction if one has already arrived for the
   * current inference window. `chatCtx` is accepted (and ignored) so the
   * call site stays uniform with text-based `_TurnDetector` impls.
   */
  async predictEndOfTurn(
    _chatCtx?: ChatContext,
    optsOrTimeoutMs?: { timeoutMs?: number } | number,
  ): Promise<number> {
    // Accept both the options-bag form (FSM-native) and the positional-ms
    // form (matches the `_TurnDetector` Protocol so audio detectors are a
    // drop-in for text-based detectors).
    const opts: { timeoutMs?: number } =
      typeof optsOrTimeoutMs === 'number' ? { timeoutMs: optsOrTimeoutMs } : optsOrTimeoutMs ?? {};
    if (this._lastPrediction !== undefined) {
      return this._lastPrediction.endOfTurnProbability;
    }
    if (!this._userTurnStarted) {
      if (!this._latePredictWarned) {
        this._latePredictWarned = true;
        this._logger.warn(
          'predictEndOfTurn called after the audio eot model already committed ' +
            'the turn (likely a late stt final). consider raising `minDelay` in ' +
            'the endpointing options to accommodate slow stt. subsequent ' +
            'occurrences on this stream will log at debug level.',
        );
      } else {
        this._logger.debug('stt transcript arrived after a turn commit, short-circuiting');
      }
      return 1.0;
    }

    const timeoutMs = opts.timeoutMs ?? 500;
    let fut: Future<number> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      fut = this.warmup();
      this.activate();
      const winner = await Promise.race([
        fut.await.then((v) => ({ kind: 'value', v }) as const),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
        }),
      ]);
      if (winner.kind === 'value') {
        return winner.v;
      }
      throw new Error('__eot_predict_timeout__');
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === '__eot_predict_timeout__';
      if (!isTimeout) throw err;
      // Contract on timeout: we couldn't tell within `timeoutMs`, so assume
      // the turn is over. Resolve the future with 1.0 (so any concurrent
      // waiter sees the same value) and deactivate the inference window
      // (a stale prediction arriving later must not fire an event).
      this._logger.warn(
        {
          timeoutMs,
          requestId: this._preemptiveRequestId,
          default: 1.0,
        },
        'eot prediction timed out, returning a default value',
      );
      if (fut !== undefined && !fut.done) {
        fut.resolve(1.0);
      }
      this.deactivate('predict_end_of_turn timeout');
      this._onPredictTimeout();
      // Positive default so minEndpointingDelay applies.
      return 1.0;
    } finally {
      // Always release the timer — on the value path the timeout would
      // otherwise keep the event loop alive until it fires, and N
      // concurrent turns would queue N pending timers.
      if (timeoutId !== undefined) clearTimeout(timeoutId);
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
    this.endInput();
    this._closing = true;
    this._swapController.abort();
    await cancelAndWait([this._mainTask]);
    if (this._preemptiveRequestFut !== undefined && !this._preemptiveRequestFut.done) {
      this._preemptiveRequestFut.resolve(0.0);
    }
    this._preemptiveRequestFut = undefined;
    this._preemptiveRequestId = undefined;
    this._status = Status.IDLE;
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
