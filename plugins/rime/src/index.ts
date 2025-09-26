// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './models.js';
export * from './tts.js';

class RimePlugin extends Plugin {
  constructor() {
    super({
      title: 'rime',
      version: '0.1.0',
      package: '@livekit/agents-plugin-rime',
    });
  }
}

Plugin.registerPlugin(new RimePlugin());
