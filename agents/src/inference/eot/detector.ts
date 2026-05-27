// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio end-of-turn detector with cloud → local fallback.
 *
 * Port of Python `livekit.agents.inference.eot.detector`.
 */
import type { InferenceExecutor } from '../../ipc/inference_executor.js';
import { getJobContext } from '../../job.js';
import type { LanguageCode } from '../../language.js';
import { log } from '../../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { isHosted, resolveEnvVar } from '../../utils.js';
import {
  type AudioTurnDetectionTransport,
  AudioTurnDetector as AudioTurnDetectorBase,
  AudioTurnDetectorStream,
  DEFAULT_SAMPLE_RATE,
  SwapAbortError,
  type TurnDetectorOptions,
} from '../../voice/turn_config/audio_turn_detector.js';
import { getDefaultInferenceUrl } from '../utils.js';
import { type Backend, materializeThresholds, rescaleForLocalFallback } from './languages.js';
import { CloudTransport, type CloudTransportOptions, LocalTransport } from './transports.js';

// Wire-level model id sent to the gateway. Decoupled from the public `backend`
// option so we don't leak gateway routing names into the API.
const WIRE_MODEL: Record<Backend, string> = {
  cloud: 'eot-audio',
  local: 'eot-audio-mini',
};

export interface AudioTurnDetectorOptions {
  backend?: Backend;
  unlikelyThreshold?: number | Record<string, number>;
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  /** Sample rate (Hz). Defaults to 16000. */
  sampleRate?: number;
  connOptions?: APIConnectOptions;
  /**
   * Inference executor that runs the local EOT model in the shared inference
   * process. Defaults to the current job's `getJobContext().inferenceExecutor`.
   * `undefined` (no job context / binding unavailable) degrades the local
   * backend to a positive-default prediction. Mainly an override seam for tests.
   */
  executor?: InferenceExecutor;
}

export class AudioTurnDetector extends AudioTurnDetectorBase {
  protected _backend: Backend;
  protected _cloudOpts: CloudTransportOptions | undefined;
  protected _executor: InferenceExecutor | undefined;
  /**
   * Active-backend views (`model`/`backend`/`unlikelyThreshold`, read by
   * metrics + `AudioRecognition`) are computed from the active stream rather
   * than written back here, so a per-stream cloud→local fallback never mutates
   * this shared detector. The detector drives a single stream at a time (see
   * `stream()`); this holds that stream while it is open. `_backend` is the
   * construction-time default, used only before any stream exists.
   */
  private _activeStreamRef: WeakRef<AudioTurnDetectorStreamImpl> | undefined;

  constructor(opts: AudioTurnDetectorOptions = {}) {
    // auto = caller didn't pin a backend; missing cloud creds warn-and-
    // fall-back instead of raising.
    const auto = opts.backend === undefined;
    let resolvedBackend: Backend = opts.backend ?? (isHosted() ? 'cloud' : 'local');

    let cloudOpts: CloudTransportOptions | undefined;
    if (resolvedBackend === 'cloud') {
      const baseUrl = resolveEnvVar(
        opts.baseUrl,
        ['LIVEKIT_INFERENCE_URL'],
        getDefaultInferenceUrl(),
      );
      const apiKey = resolveEnvVar(opts.apiKey, ['LIVEKIT_INFERENCE_API_KEY', 'LIVEKIT_API_KEY']);
      const apiSecret = resolveEnvVar(opts.apiSecret, [
        'LIVEKIT_INFERENCE_API_SECRET',
        'LIVEKIT_API_SECRET',
      ]);
      const missing: string[] = [];
      if (!baseUrl) missing.push('LIVEKIT_INFERENCE_URL');
      if (!apiKey) missing.push('LIVEKIT_API_KEY');
      if (!apiSecret) missing.push('LIVEKIT_API_SECRET');
      if (missing.length > 0) {
        if (auto) {
          log().warn(
            { missing },
            'LIVEKIT_INFERENCE_URL is set but creds are missing; falling back to local backend',
          );
          resolvedBackend = 'local';
        } else {
          throw new Error(
            `AudioTurnDetector(backend='cloud') requires ${missing.join(', ')} ` +
              '(env or constructor argument).',
          );
        }
      } else {
        cloudOpts = {
          baseUrl,
          apiKey,
          apiSecret,
          connOptions: opts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
        };
      }
    }

    const detectorOpts: TurnDetectorOptions = {
      sampleRate: opts.sampleRate ?? DEFAULT_SAMPLE_RATE,
      thresholds: materializeThresholds(opts.unlikelyThreshold, resolvedBackend),
    };
    super(detectorOpts);
    this._backend = resolvedBackend;
    this._cloudOpts = cloudOpts;
    // Default to the current job's shared inference executor. `getJobContext`
    // throws outside a job (tests, standalone) — degrade to `undefined`
    // (local backend then resolves a positive default) rather than throwing.
    if (opts.executor !== undefined) {
      this._executor = opts.executor;
    } else {
      try {
        this._executor = getJobContext().inferenceExecutor;
      } catch {
        this._executor = undefined;
      }
    }
  }

  /** @internal The detector's single live stream, or `undefined`. */
  _activeStream(): AudioTurnDetectorStreamImpl | undefined {
    return this._activeStreamRef?.deref();
  }

  override get model(): string {
    return WIRE_MODEL[this.backend];
  }

  /**
   * The active backend. After a per-session cloud→local fallback the active
   * stream holds the swapped backend, so this delegates to it; before any
   * stream exists it reports the construction-time default. The fallback state
   * lives on the stream, never written back here, so the detector reflects the
   * active backend without mutating shared state.
   */
  get backend(): Backend {
    const stream = this._activeStream();
    return stream !== undefined ? stream.backend : this._backend;
  }

  /**
   * Mirror the active-backend view: after a fallback the active stream holds
   * the rescaled local thresholds, so consult it rather than this detector's
   * construction-time `_opts` (which is never written back).
   */
  override async unlikelyThreshold(
    language: LanguageCode | undefined,
  ): Promise<number | undefined> {
    const stream = this._activeStream();
    if (stream !== undefined) {
      return stream.unlikelyThreshold(language);
    }
    return super.unlikelyThreshold(language);
  }

  override stream(opts: { connOptions?: APIConnectOptions } = {}): AudioTurnDetectorStream {
    // Single-stream ownership: the detector exposes the active stream's
    // backend/threshold view, so it drives one stream at a time. Callers
    // replacing a stream must retire the previous one first (`detach()` +
    // `aclose()`); see audio_recognition's `updateTurnDetector`.
    if (this._activeStream() !== undefined) {
      throw new Error(
        'AudioTurnDetector already has an active stream; close (or detach) it ' +
          'before creating another.',
      );
    }
    const cloudOpts =
      this._cloudOpts !== undefined
        ? { ...this._cloudOpts, connOptions: opts.connOptions ?? this._cloudOpts.connOptions }
        : undefined;
    const stream = new AudioTurnDetectorStreamImpl({
      detector: this,
      opts: this._opts,
      cloudOpts,
      backend: this._backend,
      executor: this._executor,
    });
    this._streams.add(stream);
    this._activeStreamRef = new WeakRef(stream);
    return stream;
  }

  /** @internal Clear the active-stream slot if it still points at `stream`. */
  _clearActiveStream(stream: AudioTurnDetectorStreamImpl): void {
    if (this._activeStream() === stream) {
      this._activeStreamRef = undefined;
    }
  }
}

export interface AudioTurnDetectorStreamImplArgs {
  detector: AudioTurnDetector;
  opts: TurnDetectorOptions;
  cloudOpts: CloudTransportOptions | undefined;
  backend: Backend;
  /** Shared inference executor for the local backend (undefined degrades to
   * a positive-default prediction). */
  executor?: InferenceExecutor;
  /** Optional transport override (for tests). When omitted, a transport is
   * constructed from `backend` + `cloudOpts`. */
  transport?: AudioTurnDetectionTransport;
}

/**
 * Stream that owns the cloud → local fallback FSM. On cloud transport
 * failure (`transport.run()` raises, or `predictEndOfTurn` times out), the
 * stream swaps the transport and rescales per-language thresholds. The
 * fallback state lives on the stream; the detector reads it back through its
 * active-stream delegation rather than being mutated.
 */
export class AudioTurnDetectorStreamImpl extends AudioTurnDetectorStream {
  protected _backend: Backend;
  protected _cloudOpts: CloudTransportOptions | undefined;
  protected _executor: InferenceExecutor | undefined;
  protected _isFallback = false;
  protected _warnedCloudFailure = false;
  protected _warnedLocalFailure = false;
  private _detLogger = log();

  constructor(args: AudioTurnDetectorStreamImplArgs) {
    const transport =
      args.transport ??
      (args.backend === 'cloud'
        ? new CloudTransport({
            detector: args.detector,
            opts: args.opts,
            cloudOpts: args.cloudOpts!,
          })
        : new LocalTransport({ opts: args.opts, executor: args.executor }));
    super({ detector: args.detector, opts: args.opts, transport });
    this._backend = args.backend;
    this._cloudOpts = args.cloudOpts;
    this._executor = args.executor;
  }

  get backend(): Backend {
    return this._backend;
  }

  /** Wire model id for this stream's *current* backend (flips to the mini
   * model after a cloud→local fallback). Self-contained: the stream owns its
   * active backend, so this reports "local" after a fallback while the
   * detector delegates here for its own view. */
  override get model(): string {
    return WIRE_MODEL[this._backend];
  }

  get isFallback(): boolean {
    return this._isFallback;
  }

  /** @internal Test-visible. */
  get warnedCloudFailure(): boolean {
    return this._warnedCloudFailure;
  }
  /** @internal Test-visible. */
  get warnedLocalFailure(): boolean {
    return this._warnedLocalFailure;
  }
  /** @internal Test-visible. */
  get transport(): AudioTurnDetectionTransport {
    return this._transport;
  }

  /** @internal Test-visible: same logic as the path taken when `_run` catches
   * a cloud transport error. Tests call this directly to verify the warning
   * dedupe across multiple invocations on the same stream. */
  _fallBackToLocal(reason: Error): void {
    if (!this._warnedCloudFailure) {
      this._detLogger.warn(
        { reason: reason.message },
        'cloud audio eot failed; falling back to local mini model',
      );
      this._warnedCloudFailure = true;
    }
    this._emitDefaultForInflight();
    try {
      this._transport.detach();
    } catch {
      // ignore detach errors during swap
    }
    const rescaled = rescaleForLocalFallback(this._opts.thresholds);
    this._opts = { ...this._opts, thresholds: rescaled };
    this._transport = new LocalTransport({ opts: this._opts, executor: this._executor });
    this._transport.bind(this);
    this._backend = 'local';
    this._isFallback = true;
    // The fallback view is owned by this stream (`backend`/`model`/`_opts`);
    // we deliberately don't write it back onto the shared detector, so a
    // fallback here can't corrupt another stream off the same detector.
  }

  /** @internal Test-visible: same logic as the path taken when `_run` sees a
   * local transport error. */
  _onLocalFailure(reason: Error): void {
    if (!this._warnedLocalFailure) {
      this._detLogger.warn(
        { reason: reason.message },
        'local audio eot mini failed; defaulting to 1.0 and retrying on next turn',
      );
      this._warnedLocalFailure = true;
    }
    this._emitDefaultForInflight();
  }

  protected _emitDefaultForInflight(): void {
    const requestId = this._preemptiveRequestId;
    if (requestId !== undefined) {
      this._handlePrediction(requestId, 1.0);
    }
  }

  /**
   * Release the detector's single-stream slot if it still points at us, so a
   * replacement stream can register while our async teardown finishes.
   * Idempotent: once cleared, `_activeStream()` no longer returns us.
   */
  override detach(): void {
    const detector = this._detector;
    if (detector instanceof AudioTurnDetector) {
      detector._clearActiveStream(this);
    }
  }

  override async aclose(): Promise<void> {
    this.detach();
    // Detach the transport first so the cloud send channel closes and its
    // background sender/recv tasks tear down, then run the base teardown
    // (which closes the audio channel and cancels the main task).
    try {
      this._transport.detach();
    } catch {
      // ignore detach errors during teardown
    }
    await super.aclose();
  }

  protected override async _run(): Promise<void> {
    while (true) {
      try {
        await this._raceWithSwap(this._transport.run());
        return;
      } catch (err) {
        if (err instanceof SwapAbortError) {
          if (this._closing) return;
          // A swap already happened (e.g. predict timeout → fallback).
          // The new transport is mounted; loop and run it. Routing the
          // swap through `SwapAbortError` (rather than through the
          // cloud/local branch below) is what prevents the "timeout
          // flips backend mid-await" misclassification — the catch
          // exits early before ever consulting `_backend`.
          continue;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        if (this._backend === 'cloud') {
          this._fallBackToLocal(e);
          continue;
        }
        this._onLocalFailure(e);
        return;
      }
    }
  }

  protected override _onPredictTimeout(): void {
    if (this._backend === 'cloud') {
      // Signal the swap BEFORE mutating backend/transport state. The
      // race in `_raceWithSwap` is rejected with `SwapAbortError`
      // immediately, so the main loop exits through the
      // SwapAbortError branch and never consults `_backend` for a
      // classification that would race with the assignment below.
      this._signalSwap();
      this._fallBackToLocal(new Error('predict_end_of_turn'));
    }
  }
}
