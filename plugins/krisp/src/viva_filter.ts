// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Krisp VIVA noise reduction audio filter for LiveKit Agents.
 *
 * Exposes {@link KrispVivaFilterFrameProcessor}, a thin facade that forwards to
 * one of two underlying FrameProcessor implementations:
 *
 * - The closed-source `@livekit/plugins-krisp-viva-internal` backend (default;
 *   authenticates via the LiveKit Cloud-managed JWT the agent framework hands to
 *   FrameProcessors through `onCredentialsUpdated`).
 * - A local license-mode wrapper around `krisp-audio-node-sdk` (selected when the
 *   user passes a {@link KrispLicenseAuthProvider}).
 */
import type * as KrispInternal from '@livekit/plugins-krisp-viva-internal';
import type {
  AudioFrame,
  FrameProcessorCredentials,
  FrameProcessorStreamInfo,
} from '@livekit/rtc-node';
import { FrameProcessor } from '@livekit/rtc-node';
import { createRequire } from 'node:module';
import { KrispLicenseFrameProcessor } from './_krisp.js';
import { type AuthProvider, LIVEKIT_CLOUD_KIND, LiveKitCloudAuthProvider } from './auth.js';

const require = createRequire(import.meta.url);

/**
 * Structural type for the backend FrameProcessors the facade forwards to.
 *
 * Both backends are `FrameProcessor<AudioFrame>` implementations that additionally
 * expose a runtime-settable noise suppression level (not part of the base
 * FrameProcessor interface).
 */
interface KrispBackend extends FrameProcessor<AudioFrame> {
  readonly noiseSuppressionLevel: number;
  setNoiseSuppressionLevel(value: number): void;
}

/**
 * Options for {@link KrispVivaFilterFrameProcessor}.
 * @public
 */
export interface KrispVivaFilterOptions {
  /**
   * Authentication backend. Defaults to {@link LiveKitCloudAuthProvider}
   * (LiveKit Cloud auth + bundled model — no keys or model files). Pass a
   * {@link KrispLicenseAuthProvider} to use a Krisp license key + `.kef` model
   * file directly.
   */
  authProvider: AuthProvider;
  /** Noise suppression strength, 0..=100 where 100 is maximum suppression. Default 100. */
  noiseSuppressionLevel: number;
}

const DEFAULT_FRAME_DURATION_MS = 10;

function buildBackend(provider: AuthProvider, noiseSuppressionLevel: number): KrispBackend {
  if (provider.kind === LIVEKIT_CLOUD_KIND) {
    let mod: typeof KrispInternal;
    try {
      mod = require('@livekit/plugins-krisp-viva-internal');
    } catch {
      throw new Error(
        '@livekit/plugins-krisp-viva-internal is missing — this package is bundled ' +
          'with @livekit/agents-plugin-krisp, so this likely means a broken install. ' +
          'Reinstall the plugin, or pass a KrispLicenseAuthProvider if you have a Krisp ' +
          'license key + .kef model.',
      );
    }
    return new mod.KrispVivaFilterFrameProcessor({
      mode: 'voiceIsolation',
      noiseSuppressionLevel,
      frameDurationMs: DEFAULT_FRAME_DURATION_MS,
    });
  }

  // KrispLicenseAuthProvider
  return new KrispLicenseFrameProcessor({
    licenseKey: provider.licenseKey,
    modelPath: provider.modelPath,
    noiseSuppressionLevel,
    frameDurationMs: DEFAULT_FRAME_DURATION_MS,
  });
}

/**
 * FrameProcessor for Krisp noise reduction.
 *
 * Thin facade over two backend FrameProcessor implementations: the LiveKit
 * Cloud-bundled package (default) and a local wrapper around the public
 * `krisp-audio-node-sdk` (selected via {@link KrispLicenseAuthProvider}).
 *
 * @example
 * ```ts
 * import { voice } from '@livekit/agents';
 * import * as krisp from '@livekit/agents-plugin-krisp';
 *
 * // Default: LiveKit Cloud auth + bundled model. No keys or model files.
 * const processor = new krisp.KrispVivaFilterFrameProcessor();
 *
 * // Or, explicit Krisp-direct auth with a license + model file.
 * const processor = new krisp.KrispVivaFilterFrameProcessor({
 *   authProvider: krisp.auth.krispLicense({
 *     licenseKey: '...',
 *     modelPath: '/path/to/model.kef',
 *   }),
 * });
 *
 * await session.start({
 *   agent,
 *   room: ctx.room,
 *   inputOptions: { noiseCancellation: processor },
 * });
 * ```
 *
 * @public
 */
export class KrispVivaFilterFrameProcessor extends FrameProcessor<AudioFrame> {
  private readonly inner: KrispBackend;

  constructor(opts: Partial<KrispVivaFilterOptions> = {}) {
    super();
    const provider = opts.authProvider ?? new LiveKitCloudAuthProvider();
    this.inner = buildBackend(provider, opts.noiseSuppressionLevel ?? 100);
  }

  isEnabled(): boolean {
    return this.inner.isEnabled();
  }

  setEnabled(enabled: boolean): void {
    this.inner.setEnabled(enabled);
  }

  get noiseSuppressionLevel(): number {
    return this.inner.noiseSuppressionLevel;
  }

  /** Adjust the noise suppression level (0-100) at runtime. */
  setNoiseSuppressionLevel(value: number): void {
    this.inner.setNoiseSuppressionLevel(value);
  }

  override onStreamInfoUpdated(info: FrameProcessorStreamInfo): void {
    this.inner.onStreamInfoUpdated(info);
  }

  override onCredentialsUpdated(credentials: FrameProcessorCredentials): void {
    this.inner.onCredentialsUpdated(credentials);
  }

  process(frame: AudioFrame): AudioFrame {
    return this.inner.process(frame);
  }

  close(): void {
    this.inner.close();
  }
}
