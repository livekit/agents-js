// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './types.js';
export * from './api.js';
export * from './avatar.js';

class DIDPlugin extends Plugin {
  constructor() {
    super({
      title: 'd-id',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new DIDPlugin());
