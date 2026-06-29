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
 *   model file (requires the public `krisp-audio-node-sdk`).
 *
 * @example
 * ```ts
 * import * as krisp from '@livekit/agents-plugin-krisp';
 *
 * const processor = new krisp.KrispVivaFilterFrameProcessor();
 * ```
 *
 * @packageDocumentation
 */
import { Plugin } from '@livekit/agents';

export {
  type AuthProvider,
  auth,
  KrispLicenseAuthProvider,
  type KrispLicenseAuthProviderOptions,
  LiveKitCloudAuthProvider,
} from './auth.js';
export { KrispVivaFilterFrameProcessor, type KrispVivaFilterOptions } from './viva_filter.js';

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
