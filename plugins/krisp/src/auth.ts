// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication providers for the Krisp plugin.
 *
 * These types are plain configuration holders — {@link krispVivaFilter}
 * dispatches on the provider instance to pick the matching backend FrameProcessor
 * implementation.
 *
 * - {@link LiveKitCloudAuthProvider} (default): selects the closed-source
 *   `@livekit/plugins-krisp-viva-internal` backend. It bundles the model and
 *   authenticates against LiveKit Cloud using the room JWT, which the agent
 *   framework hands to the FrameProcessor via the standard `onCredentialsUpdated`
 *   callback.
 * - {@link KrispLicenseAuthProvider}: selects the public `krisp-audio-node-sdk`
 *   together with a Krisp license key and a `.kef` model file.
 *
 * Preferred call sites use the {@link auth} namespace:
 *
 * ```ts
 * import { auth } from '@livekit/agents-plugin-krisp';
 *
 * auth.livekitCloud();
 * auth.krispLicense({ modelPath: '/path/to/model.kef' });
 * ```
 */
import { existsSync, statSync } from 'node:fs';

/**
 * Discriminator symbols identifying each auth provider, registered in the global
 * symbol registry via `Symbol.for` so the {@link krispVivaFilter}
 * facade can dispatch reliably even when this module is loaded more than once
 * (e.g. duplicate copies through bundling or linked workspaces) — a case where
 * `instanceof` would silently fail. Not part of the public API surface.
 */
export const LIVEKIT_CLOUD_KIND: unique symbol = Symbol.for(
  'livekit.agents.krisp.auth.livekitCloud',
);
export const KRISP_LICENSE_KIND: unique symbol = Symbol.for(
  'livekit.agents.krisp.auth.krispLicense',
);

/**
 * Marker for the LiveKit Cloud-bundled Krisp backend.
 *
 * Auth + metering happen inside `@livekit/plugins-krisp-viva-internal`, which
 * receives the room JWT via the standard FrameProcessor `onCredentialsUpdated`
 * callback (forwarded by the facade). There is nothing to configure on this side.
 *
 * @public
 */
export class LiveKitCloudAuthProvider {
  /** @internal */
  readonly kind: typeof LIVEKIT_CLOUD_KIND = LIVEKIT_CLOUD_KIND;
}

/**
 * Options for {@link KrispLicenseAuthProvider}.
 * @public
 */
export interface KrispLicenseAuthProviderOptions {
  /** Path to the Krisp `.kef` model file. Falls back to `KRISP_VIVA_FILTER_MODEL_PATH`. */
  modelPath?: string;
}

/**
 * Krisp-direct auth using a `.kef` model file.
 *
 * The `modelPath` defaults to `KRISP_VIVA_FILTER_MODEL_PATH`. The Krisp license
 * key is supplied separately via the `KRISP_VIVA_SDK_LICENSE_KEY` environment
 * variable, which the native SDK reads on initialization.
 *
 * @public
 */
export class KrispLicenseAuthProvider {
  /** @internal */
  readonly kind: typeof KRISP_LICENSE_KIND = KRISP_LICENSE_KIND;
  readonly modelPath: string;

  constructor(opts: KrispLicenseAuthProviderOptions = {}) {
    const resolvedModelPath = opts.modelPath ?? process.env.KRISP_VIVA_FILTER_MODEL_PATH;

    if (!resolvedModelPath) {
      throw new Error(
        'Krisp model path is required. Pass modelPath=... or set KRISP_VIVA_FILTER_MODEL_PATH.',
      );
    }
    if (!resolvedModelPath.endsWith('.kef')) {
      throw new Error('Krisp model must have a .kef extension');
    }
    if (!existsSync(resolvedModelPath) || !statSync(resolvedModelPath).isFile()) {
      throw new Error(`Krisp model file not found: ${resolvedModelPath}`);
    }

    this.modelPath = resolvedModelPath;
  }
}

/** @public */
export type AuthProvider = LiveKitCloudAuthProvider | KrispLicenseAuthProvider;

/**
 * Preferred factory namespace for auth providers.
 *
 * ```ts
 * import { auth } from '@livekit/agents-plugin-krisp';
 *
 * auth.livekitCloud();
 * auth.krispLicense({ modelPath: '/path/to/model.kef' });
 * ```
 *
 * @public
 */
export const auth = {
  livekitCloud: (): LiveKitCloudAuthProvider => new LiveKitCloudAuthProvider(),
  krispLicense: (opts?: KrispLicenseAuthProviderOptions): KrispLicenseAuthProvider =>
    new KrispLicenseAuthProvider(opts),
};
