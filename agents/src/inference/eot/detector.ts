// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio end-of-turn detector with `turn-detector-v1` → `turn-detector-v1-mini`
 * (cloud → local) fallback.
 */
import type { InferenceExecutor } from '../../ipc/inference_executor.js';
import { getJobContext } from '../../job.js';
import { log } from '../../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { isDevMode, isHosted, resolveEnvVar } from '../../utils.js';
import { getDefaultInferenceUrl } from '../utils.js';
import {
  BaseStreamingTurnDetector,
  type BaseStreamingTurnDetectorOptions,
  BaseStreamingTurnDetectorStream,
  DEFAULT_SAMPLE_RATE,
  type StreamingTurnDetectionTransport,
  SwapAbortError,
} from './base.js';
import { ThresholdOptions, type TurnDetectorModel, type TurnDetectorVersion } from './languages.js';
import { CloudTransport, type CloudTransportOptions, LocalTransport } from './transports.js';

export interface TurnDetectorOptions {
  /**
   * Which turn-detector version to run. `'v1'` is the full cloud model (served
   * over the inference gateway; model name `'turn-detector-v1'`); `'v1-mini'`
   * is the local in-process model (`'turn-detector-v1-mini'`). When omitted,
   * auto-selects `'v1'` on hosted/dev environments (falling back to `'v1-mini'`
   * if cloud creds are missing) and `'v1-mini'` otherwise.
   */
  version?: TurnDetectorVersion;
  unlikelyThreshold?: number | Record<string, number>;
  /**
   * Backchannel threshold(s): above this, a pause is a backchannel opportunity.
   * Server-driven and cloud-only by default; this is an override seam. A scalar
   * applies to every language; a map is layered over the server defaults.
   */
  backchannelThreshold?: number | Record<string, number>;
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  /** Sample rate (Hz). Defaults to 16000. */
  sampleRate?: number;
  connOptions?: APIConnectOptions;
  /**
   * Inference executor that runs the local `turn-detector-v1-mini` model in the
   * shared inference process. Defaults to the current job's
   * `getJobContext().inferenceExecutor`. `undefined` (no job context / binding
   * unavailable) degrades the local model to a positive-default prediction.
   * Mainly an override seam for tests.
   */
  executor?: InferenceExecutor;
}

export class TurnDetector extends BaseStreamingTurnDetector {
  protected _model: TurnDetectorModel;
  protected _cloudOpts: CloudTransportOptions | undefined;
  protected _executor: InferenceExecutor | undefined;

  constructor(opts: TurnDetectorOptions = {}) {
    // auto = caller didn't pin a version; missing cloud creds warn-and-
    // fall-back instead of raising.
    const auto = opts.version === undefined;
    const resolvedVersion: TurnDetectorVersion =
      opts.version ?? (isHosted() || isDevMode() ? 'v1' : 'v1-mini');
    let resolvedModel: TurnDetectorModel = `turn-detector-${resolvedVersion}`;

    let cloudOpts: CloudTransportOptions | undefined;
    if (resolvedVersion === 'v1') {
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
            "LIVEKIT_INFERENCE_URL is set but creds are missing; falling back to 'v1-mini'",
          );
          resolvedModel = 'turn-detector-v1-mini';
        } else {
          throw new Error(
            `TurnDetector(version='v1') requires ${missing.join(', ')} ` +
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

    const detectorOpts: BaseStreamingTurnDetectorOptions = {
      sampleRate: opts.sampleRate ?? DEFAULT_SAMPLE_RATE,
      thresholds: new ThresholdOptions(
        resolvedModel,
        opts.unlikelyThreshold,
        opts.backchannelThreshold,
      ),
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

  /** Current model name. Starts at the construction-time selection and flips to
   * `'turn-detector-v1-mini'` after a cloud→local fallback: the detector and its
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
    const bcOverrides = this._opts.thresholds.backchannelOverrides;
    if (bcOverrides !== undefined) {
      log().warn(
        { backchannelThreshold: bcOverrides },
        'a non-default backchannel threshold was provided; the server provides calibrated ' +
          'defaults and overriding them may be suboptimal',
      );
    }
  }

  /** Replace the user threshold override at runtime. The shared
   * `ThresholdOptions` re-resolves against the current (server or shipped)
   * defaults, so an active stream picks it up immediately. */
  updateOptions(
    opts: {
      unlikelyThreshold?: number | Record<string, number>;
      backchannelThreshold?: number | Record<string, number>;
    } = {},
  ): void {
    if (opts.unlikelyThreshold !== undefined) {
      this._opts.thresholds.updateOverrides(opts.unlikelyThreshold);
    }
    if (opts.backchannelThreshold !== undefined) {
      this._opts.thresholds.updateBackchannelOverrides(opts.backchannelThreshold);
    }
    this._warnThresholdOverride();
  }

  override stream(opts: { connOptions?: APIConnectOptions } = {}): BaseStreamingTurnDetectorStream {
    const cloudOpts =
      this._cloudOpts !== undefined
        ? { ...this._cloudOpts, connOptions: opts.connOptions ?? this._cloudOpts.connOptions }
        : undefined;
    const stream = new TurnDetectorStreamImpl({
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

export interface TurnDetectorStreamImplArgs {
  detector: TurnDetector;
  opts: BaseStreamingTurnDetectorOptions;
  cloudOpts: CloudTransportOptions | undefined;
  model: TurnDetectorModel;
  /** Shared inference executor for the `turn-detector-v1-mini` (local) model
   * (undefined degrades to a positive-default prediction). */
  executor?: InferenceExecutor;
  /** Optional transport override (for tests). When omitted, a transport is
   * constructed from `model` + `cloudOpts`. */
  transport?: StreamingTurnDetectionTransport;
}

/**
 * Stream that owns the `turn-detector-v1` → `turn-detector-v1-mini` (cloud →
 * local) fallback FSM. On cloud transport failure (`transport.run()` raises, or
 * `predictEndOfTurn` times out), the stream swaps the transport and rescales
 * per-language thresholds in place on the shared `ThresholdOptions`, then writes
 * the model swap back to the owning detector so its view stays consistent.
 */
export class TurnDetectorStreamImpl extends BaseStreamingTurnDetectorStream {
  protected _model: TurnDetectorModel;
  protected _cloudOpts: CloudTransportOptions | undefined;
  protected _executor: InferenceExecutor | undefined;
  protected _isFallback = false;
  protected _warnedCloudFailure = false;
  protected _warnedLocalFailure = false;
  private _detLogger = log();

  constructor(args: TurnDetectorStreamImplArgs) {
    const transport =
      args.transport ??
      (args.model === 'turn-detector-v1'
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

  /** This stream's *current* model name (flips to `'turn-detector-v1-mini'`
   * after a cloud→local fallback). The swap is also written back to the owning
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
  get transport(): StreamingTurnDetectionTransport {
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
    if (this._detector instanceof TurnDetector) {
      this._detector._setModel('turn-detector-v1-mini');
    }
    this._transport = new LocalTransport({ opts: this._opts, executor: this._executor });
    this._transport.attach(this);
    this._model = 'turn-detector-v1-mini';
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
    // Positive default so any waiter commits after minEndpointingDelay.
    const requestId = this._requestId;
    if (requestId !== undefined) {
      this._resolvePrediction(requestId, 1.0);
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
        if (this._model === 'turn-detector-v1') {
          this._fallBackToLocal(e);
          continue;
        }
        this._onLocalFailure(e);
        return;
      }
    }
  }

  protected override _onPredictTimeout(): void {
    if (this._model === 'turn-detector-v1') {
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
