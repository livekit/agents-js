// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './models.js';
// Ref: python livekit-plugins/livekit-plugins-elevenlabs/livekit/plugins/elevenlabs/__init__.py - 20-21 lines
export * from './stt.js';
export * from './tts.js';

class ElevenLabsPlugin extends Plugin {
  constructor() {
    super({
      title: 'elevenlabs',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new ElevenLabsPlugin());
