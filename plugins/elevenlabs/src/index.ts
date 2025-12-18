// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './models.js';
export * from './tts.js';

class ElevenLabsPlugin extends Plugin {
  constructor() {
    super({
      title: 'elevenlabs',
      version: '0.6.2',
      package: '@livekit/agents-plugin-elevenlabs',
    });
  }
}

Plugin.registerPlugin(new ElevenLabsPlugin());
