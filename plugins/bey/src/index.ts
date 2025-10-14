// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import { version } from './version.js';

export * from './avatar.js';

class BeyPlugin extends Plugin {
  constructor() {
    super({
      title: 'bey',
      version,
      package: '@livekit/agents-plugin-bey',
    });
  }
}

Plugin.registerPlugin(new BeyPlugin());
