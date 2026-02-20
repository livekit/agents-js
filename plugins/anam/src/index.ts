// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './types.js';
export * from './api.js';
export * from './avatar.js';

class AnamPlugin extends Plugin {
  constructor() {
    super({
      title: 'anam',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}
Plugin.registerPlugin(new AnamPlugin());
