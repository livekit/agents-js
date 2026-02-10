// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './models.js';
export { ChunkedStream, TTS, type TTSOptions } from './tts.js';

class SarvamPlugin extends Plugin {
  constructor() {
    super({
      title: 'sarvam',
      version: '0.1.0',
      package: '@livekit/agents-plugin-sarvam',
    });
  }
}

Plugin.registerPlugin(new SarvamPlugin());
