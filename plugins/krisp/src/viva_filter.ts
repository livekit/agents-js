// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioFrame,
  FrameProcessor,
  type FrameProcessorCredentials,
  type FrameProcessorStreamInfo,
} from '@livekit/rtc-node';
import { createRequire } from 'node:module';
import { KrispLicenseAuthProvider, LiveKitCloudAuthProvider } from './auth.js';
import { KrispLicenseFrameProcessor } from './krisp.js';

const require = createRequire(import.meta.url);

/** @public */
export type AuthProvider = LiveKitCloudAuthProvider | KrispLicenseAuthProvider;

type KrispBackend = FrameProcessor<AudioFrame> & {
  noiseSuppressionLevel?: number;
};

/** @public */
export type KrispVivaFilterFrameProcessorOptions = {
  authProvider?: AuthProvider;
  /** @deprecated Use `authProvider: new KrispLicenseAuthProvider({ modelPath })` instead. */
  modelPath?: string;
  noiseSuppressionLevel?: number;
  /** @deprecated The processor adapts to input frame sizes automatically. */
  frameDurationMs?: number;
  /** @deprecated The processor adapts to input sample rates automatically. */
  sampleRate?: number;
};

let legacyDeprecationShown = false;
let frameParamsDeprecationShown = false;

function resolveAuthProvider(
  authProvider: AuthProvider | undefined,
  modelPath: string | undefined,
): AuthProvider {
  if (authProvider) {
    if (modelPath !== undefined) {
      throw new Error(
        'Pass modelPath on KrispLicenseAuthProvider instead of on KrispVivaFilterFrameProcessor when an authProvider is supplied.',
      );
    }
    return authProvider;
  }

  if (modelPath !== undefined) {
    if (!legacyDeprecationShown) {
      process.emitWarning(
        'Passing `modelPath` to KrispVivaFilterFrameProcessor is deprecated. Use `authProvider: new KrispLicenseAuthProvider({ modelPath })` instead.',
        'DeprecationWarning',
      );
      legacyDeprecationShown = true;
    }
    return new KrispLicenseAuthProvider({ modelPath });
  }

  if (process.env.KRISP_VIVA_SDK_LICENSE_KEY && process.env.KRISP_VIVA_FILTER_MODEL_PATH) {
    return new KrispLicenseAuthProvider();
  }

  return new LiveKitCloudAuthProvider();
}

function buildInner({
  provider,
  noiseSuppressionLevel,
  frameDurationMs,
  sampleRate,
}: {
  provider: AuthProvider;
  noiseSuppressionLevel: number;
  frameDurationMs: number;
  sampleRate?: number;
}): KrispBackend {
  if (provider instanceof LiveKitCloudAuthProvider) {
    let imported: unknown;
    try {
      imported = require('@livekit/agents-plugin-krisp-internal');
    } catch (error) {
      throw new Error(
        'The LiveKit Cloud Krisp backend for Node is not installed. Install a package that exports KrispVivaFilterFrameProcessor from @livekit/agents-plugin-krisp-internal, or use KrispLicenseAuthProvider if you have a Krisp Node SDK and .kef model.',
        { cause: error },
      );
    }

    const backend = imported as {
      KrispVivaFilterFrameProcessor?: new (options: {
        noiseSuppressionLevel: number;
        frameDurationMs: number;
        sampleRate?: number;
      }) => KrispBackend;
    };
    if (!backend.KrispVivaFilterFrameProcessor) {
      throw new Error(
        'The LiveKit Cloud Krisp backend does not export KrispVivaFilterFrameProcessor.',
      );
    }
    return new backend.KrispVivaFilterFrameProcessor({
      noiseSuppressionLevel,
      frameDurationMs,
      sampleRate,
    });
  }

  return KrispLicenseFrameProcessor.create({
    licenseKey: provider.licenseKey,
    modelPath: provider.modelPath,
    noiseSuppressionLevel,
    frameDurationMs,
    sampleRate,
  });
}

/**
 * FrameProcessor facade for Krisp VIVA noise reduction.
 * @public
 */
export class KrispVivaFilterFrameProcessor extends FrameProcessor<AudioFrame> {
  private inner: KrispBackend | null = null;
  private enabled = true;
  private pendingCredentials: FrameProcessorCredentials | null = null;
  private pendingStreamInfo: FrameProcessorStreamInfo | null = null;
  private noiseSuppressionLevelValue: number;

  constructor({
    authProvider,
    modelPath,
    noiseSuppressionLevel = 100,
    frameDurationMs,
    sampleRate,
  }: KrispVivaFilterFrameProcessorOptions = {}) {
    super();
    if (
      (frameDurationMs !== undefined || sampleRate !== undefined) &&
      !frameParamsDeprecationShown
    ) {
      process.emitWarning(
        'Passing `sampleRate` / `frameDurationMs` to KrispVivaFilterFrameProcessor is deprecated. The processor now adapts to the input sample rate and frame size automatically.',
        'DeprecationWarning',
      );
      frameParamsDeprecationShown = true;
    }

    this.noiseSuppressionLevelValue = noiseSuppressionLevel;
    const provider = resolveAuthProvider(authProvider, modelPath);
    const inner = buildInner({
      provider,
      noiseSuppressionLevel,
      frameDurationMs: frameDurationMs ?? 10,
      sampleRate,
    });
    this.inner = inner;
    inner.setEnabled(this.enabled);
    if ('noiseSuppressionLevel' in inner) {
      inner.noiseSuppressionLevel = this.noiseSuppressionLevelValue;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.inner?.setEnabled(enabled);
  }

  get noiseSuppressionLevel(): number {
    return this.inner?.noiseSuppressionLevel ?? this.noiseSuppressionLevelValue;
  }

  set noiseSuppressionLevel(value: number) {
    this.noiseSuppressionLevelValue = Math.max(0, Math.min(100, value));
    if (this.inner && 'noiseSuppressionLevel' in this.inner) {
      this.inner.noiseSuppressionLevel = this.noiseSuppressionLevelValue;
    }
  }

  override onCredentialsUpdated(credentials: FrameProcessorCredentials): void {
    this.pendingCredentials = credentials;
    this.inner?.onCredentialsUpdated(credentials);
  }

  override onCredentialsCleared(): void {
    this.pendingCredentials = null;
    this.inner?.onCredentialsCleared();
  }

  override onStreamInfoUpdated(info: FrameProcessorStreamInfo): void {
    this.pendingStreamInfo = info;
    this.inner?.onStreamInfoUpdated(info);
  }

  override onStreamInfoCleared(): void {
    this.pendingStreamInfo = null;
    this.inner?.onStreamInfoCleared();
  }

  process(frame: AudioFrame): AudioFrame {
    if (!this.inner) {
      throw new Error('KrispVivaFilterFrameProcessor backend is not initialized.');
    }
    return this.inner.process(frame);
  }

  close(): void {
    this.inner?.close();
  }
}
