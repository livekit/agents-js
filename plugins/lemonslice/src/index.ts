// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import { version } from './version.js';

export * from './avatar.js';

class LemonSlicePlugin extends Plugin {
  constructor() {
    super({
      title: 'lemonslice',
      version,
      package: '@livekit/agents-plugin-lemonslice',
    });
  }
}

Plugin.registerPlugin(new LemonSlicePlugin());
