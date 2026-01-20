// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './tts.js';
export * from './models.js';

class ResemblePlugin extends Plugin {
  constructor() {
    super({
      title: 'resemble',
      version: '0.1.0',
      package: '@livekit/agents-plugin-resemble',
    });
  }
}

Plugin.registerPlugin(new ResemblePlugin());
