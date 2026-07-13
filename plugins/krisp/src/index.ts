// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import * as auth from './auth.js';

export { auth };
export {
  KrispLicenseAuthProvider,
  LiveKitCloudAuthProvider,
  krispLicense,
  livekitCloud,
  type KrispLicenseAuthProviderOptions,
} from './auth.js';
export {
  KrispVivaFilterFrameProcessor,
  type AuthProvider,
  type KrispVivaFilterFrameProcessorOptions,
} from './viva_filter.js';

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
