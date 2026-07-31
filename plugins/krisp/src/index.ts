// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Krisp VIVA plugin for LiveKit Agents.
 *
 * Real-time noise reduction as a `FrameProcessor`. Two authentication backends
 * are supported, exposed under the {@link auth} namespace:
 *
 * - `auth.livekitCloud()` (default): LiveKit Cloud-managed auth + bundled model.
 *   No Krisp keys or model files required.
 * - `auth.krispLicense(...)`: Krisp-direct auth using a license key and a `.kef`
 *   model file (requires the proprietary `@krisp/viva-node-sdk`).
 *
 * Two voice isolation modes are available: {@link voiceIsolation} for general
 * use and {@link voiceIsolationTelephony} tuned for telephony audio.
 *
 * @example
 * ```ts
 * import * as krisp from '@livekit/agents-plugin-krisp';
 *
 * const processor = krisp.voiceIsolation();
 * ```
 *
 * @packageDocumentation
 */
import { Plugin } from '@livekit/agents';
import { KrispVivaFilter, type KrispVivaFilterOptions } from './viva_filter.js';

export { type KrispVivaFilter, type KrispVivaFilterOptions };

export {
  type AuthProvider,
  auth,
  KrispLicenseAuthProvider,
  LiveKitCloudAuthProvider,
} from './auth.js';

/**
 * Create a Krisp VIVA voice isolation `FrameProcessor`.
 *
 * Pass the result as `noiseCancellation` in the session's input options. Uses
 * LiveKit Cloud auth by default; pass `authProvider: auth.krispLicense(...)` to
 * run the proprietary Krisp SDK with your own license + `.kef` model.
 *
 * @public
 */
export function voiceIsolation(options?: Partial<KrispVivaFilterOptions>): KrispVivaFilter {
  return new KrispVivaFilter(options, 'voiceIsolation');
}

/**
 * Create a Krisp VIVA voice isolation `FrameProcessor` for telephony use cases.
 *
 * Pass the result as `noiseCancellation` in the session's input options. Uses
 * LiveKit Cloud auth by default; pass `authProvider: auth.krispLicense(...)` to
 * run the proprietary Krisp SDK with your own license + `.kef` model.
 *
 * @public
 */
export function voiceIsolationTelephony(
  options?: Partial<KrispVivaFilterOptions>,
): KrispVivaFilter {
  return new KrispVivaFilter(options, 'voiceIsolationTelephony');
}

class KrispPlugin extends Plugin {
  constructor() {
    super({
      title: 'krisp',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new KrispPlugin());
