// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import { version } from './version.js';

export * from './avatar.js';

class HedraPlugin extends Plugin {
  constructor() {
    super({
      title: 'hedra',
      version,
      package: '@livekit/agents-plugin-hedra',
    });
  }
}

Plugin.registerPlugin(new HedraPlugin());
