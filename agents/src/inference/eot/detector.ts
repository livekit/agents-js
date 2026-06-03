// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio end-of-turn detector with `turn-detector` → `turn-detector-mini`
 * (cloud → local) fallback.
 *
 * Port of Python `livekit.agents.inference.eot.detector`.
 */
import type { InferenceExecutor } from '../../ipc/inference_executor.js';
import { getJobContext } from '../../job.js';
import { log } from '../../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { isDevMode, isHosted, resolveEnvVar } from '../../utils.js';
import { getDefaultInferenceUrl } from '../utils.js';
import {
  type AudioTurnDetectionTransport,
  AudioTurnDetector as AudioTurnDetectorBase,
  AudioTurnDetectorStream,
  DEFAULT_SAMPLE_RATE,
  SwapAbortError,
  type TurnDetectorOptions,
} from './base.js';
import { ThresholdOptions, type TurnDetectorModel } from './languages.js';
import { CloudTransport, type CloudTransportOptions, LocalTransport } from './transports.js';

export interface AudioTurnDetectorOptions {
  /**
   * Which turn-detector checkpoint to run. `'turn-detector'` is the full
   * cloud model (served over the inference gateway); `'turn-detector-mini'`
   * is the local in-process model. When omitted, auto-selects `'turn-detector'`
   * on hosted/dev environments (falling back to `'turn-detector-mini'` if cloud
   * creds are missing) and `'turn-detector-mini'` otherwise.
   */
  model?: TurnDetectorModel;
  unlikelyThreshold?: number | Record<string, number>;
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  /** Sample rate (Hz). Defaults to 16000. */
  sampleRate?: number;
  connOptions?: APIConnectOptions;
  /**
   * Inference executor that runs the local `turn-detector-mini` model in the
   * shared inference process. Defaults to the current job's
   * `getJobContext().inferenceExecutor`. `undefined` (no job context / binding
   * unavailable) degrades the local model to a positive-default prediction.
   * Mainly an override seam for tests.
   */
  executor?: InferenceExecutor;
}

export class AudioTurnDetector extends AudioTurnDetectorBase {
  protected _model: TurnDetectorModel;
  protected _cloudOpts: CloudTransportOptions | undefined;
  protected _executor: InferenceExecutor | undefined;

  constructor(opts: AudioTurnDetectorOptions = {}) {
    // auto = caller didn't pin a model; missing cloud creds warn-and-
    // fall-back instead of raising.
    const auto = opts.model === undefined;
    let resolvedModel: TurnDetectorModel =
      opts.model ?? (isHosted() || isDevMode() ? 'turn-detector' : 'turn-detector-mini');

    let cloudOpts: CloudTransportOptions | undefined;
    if (resolvedModel === 'turn-detector') {
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
            "LIVEKIT_INFERENCE_URL is set but creds are missing; falling back to 'turn-detector-mini'",
          );
          resolvedModel = 'turn-detector-mini';
        } else {
          throw new Error(
            `AudioTurnDetector(model='turn-detector') requires ${missing.join(', ')} ` +
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
      thresholds: new ThresholdOptions(resolvedModel, opts.unlikelyThreshold),
    };
    super(detectorOpts);
    this._model = resolvedModel;
    this._cloudOpts = cloudOpts;
    this._warnThresholdOverride();
    // Default to the current job's shared inference executor. `getJobContext`
    // throws outside a job (tests, standalone) — degrade to `undefined`
    // (the local model then resolves a positive default) rather than throwing.
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

  /** Current model. Starts at the construction-time selection and flips to
   * `'turn-detector-mini'` after a cloud→local fallback: the detector and its
   * (single) active stream share one mutable `ThresholdOptions`, and the
   * stream writes the swap back here so EOU metrics and `audio_recognition`
   * see a consistent view. The fallback is one-way and sticky. */
  override get model(): TurnDetectorModel {
    return this._model;
  }

  /** @internal Written by the active stream on cloud→local fallback. */
  _setModel(model: TurnDetectorModel): void {
    this._model = model;
  }

  protected _warnThresholdOverride(): void {
    const overrides = this._opts.thresholds.overrides;
    if (overrides !== undefined) {
      log().warn(
        { unlikelyThreshold: overrides },
        'a non-default turn detection threshold was provided; the server provides calibrated ' +
          'defaults and overriding them may be suboptimal',
      );
    }
  }

  /** Replace the user threshold override at runtime. The shared
   * `ThresholdOptions` re-resolves against the current (server or shipped)
   * defaults, so an active stream picks it up immediately. */
  updateOptions(opts: { unlikelyThreshold?: number | Record<string, number> } = {}): void {
    this._opts.thresholds.updateOverrides(opts.unlikelyThreshold);
    this._warnThresholdOverride();
  }

  override stream(opts: { connOptions?: APIConnectOptions } = {}): AudioTurnDetectorStream {
    const cloudOpts =
      this._cloudOpts !== undefined
        ? { ...this._cloudOpts, connOptions: opts.connOptions ?? this._cloudOpts.connOptions }
        : undefined;
    const stream = new AudioTurnDetectorStreamImpl({
      detector: this,
      opts: this._opts,
      cloudOpts,
      model: this._model,
      executor: this._executor,
    });
    this._streams.add(stream);
    return stream;
  }
}

export interface AudioTurnDetectorStreamImplArgs {
  detector: AudioTurnDetector;
  opts: TurnDetectorOptions;
  cloudOpts: CloudTransportOptions | undefined;
  model: TurnDetectorModel;
  /** Shared inference executor for the `turn-detector-mini` (local) model
   * (undefined degrades to a positive-default prediction). */
  executor?: InferenceExecutor;
  /** Optional transport override (for tests). When omitted, a transport is
   * constructed from `model` + `cloudOpts`. */
  transport?: AudioTurnDetectionTransport;
}

/**
 * Stream that owns the `turn-detector` → `turn-detector-mini` (cloud → local)
 * fallback FSM. On cloud transport failure (`transport.run()` raises, or
 * `predictEndOfTurn` times out), the stream swaps the transport and rescales
 * per-language thresholds in place on the shared `ThresholdOptions`, then writes
 * the model swap back to the owning detector so its view stays consistent.
 */
export class AudioTurnDetectorStreamImpl extends AudioTurnDetectorStream {
  protected _model: TurnDetectorModel;
  protected _cloudOpts: CloudTransportOptions | undefined;
  protected _executor: InferenceExecutor | undefined;
  protected _isFallback = false;
  protected _warnedCloudFailure = false;
  protected _warnedLocalFailure = false;
  private _detLogger = log();

  constructor(args: AudioTurnDetectorStreamImplArgs) {
    const transport =
      args.transport ??
      (args.model === 'turn-detector'
        ? new CloudTransport({
            detector: args.detector,
            opts: args.opts,
            cloudOpts: args.cloudOpts!,
          })
        : new LocalTransport({ opts: args.opts, executor: args.executor }));
    super({ detector: args.detector, opts: args.opts, transport });
    this._model = args.model;
    this._cloudOpts = args.cloudOpts;
    this._executor = args.executor;
  }

  /** This stream's *current* model (flips to `'turn-detector-mini'` after a
   * cloud→local fallback). The swap is also written back to the owning
   * detector, which shares this stream's mutable `ThresholdOptions`. */
  override get model(): TurnDetectorModel {
    return this._model;
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
        'cloud turn detector failed; falling back to local mini model',
      );
      this._warnedCloudFailure = true;
    }
    this._emitDefaultForInflight();
    try {
      this._transport.detach();
    } catch {
      // ignore detach errors during swap
    }
    // Mutate the shared `ThresholdOptions` in place so the rescaled local
    // thresholds + model swap are visible to the owning detector (read by EOU
    // metrics and `audio_recognition`) without a copy-back. Safe because only
    // one active stream per detector is supported, and the swap is sticky.
    this._opts.thresholds._toLocalFallback();
    if (this._detector instanceof AudioTurnDetector) {
      this._detector._setModel('turn-detector-mini');
    }
    this._transport = new LocalTransport({ opts: this._opts, executor: this._executor });
    this._transport.attach(this);
    this._model = 'turn-detector-mini';
    this._isFallback = true;
  }

  /** @internal Test-visible: same logic as the path taken when `_run` sees a
   * local transport error. */
  _onLocalFailure(reason: Error): void {
    if (!this._warnedLocalFailure) {
      this._detLogger.warn(
        { reason: reason.message },
        'local audio turn detector failed; defaulting to 1.0 and retrying on next turn',
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

  override async aclose(): Promise<void> {
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
          // flips model mid-await" misclassification — the catch
          // exits early before ever consulting `_model`.
          continue;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        if (this._model === 'turn-detector') {
          this._fallBackToLocal(e);
          continue;
        }
        this._onLocalFailure(e);
        return;
      }
    }
  }

  protected override _onPredictTimeout(): void {
    if (this._model === 'turn-detector') {
      // Signal the swap BEFORE mutating model/transport state. The
      // race in `_raceWithSwap` is rejected with `SwapAbortError`
      // immediately, so the main loop exits through the
      // SwapAbortError branch and never consults `_model` for a
      // classification that would race with the assignment below.
      this._signalSwap();
      this._fallBackToLocal(new Error('predict_end_of_turn'));
    }
  }
}
