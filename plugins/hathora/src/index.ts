// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './tts.js';
export * from './stt.js';
export * from './utils.js';

class HathoraPlugin extends Plugin {
  constructor() {
    super({
      title: 'hathora',
      version: '0.1.0',
      package: '@livekit/agents-plugin-hathora',
    });
  }
}

Plugin.registerPlugin(new HathoraPlugin());
