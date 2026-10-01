// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { STT, type SpeechStreamOptions, type STTOptions, type WebSocketFactory } from './stt.js';
export { TTS, type TTSOptions } from './tts.js';

class MicrosoftPlugin extends Plugin {
  constructor() {
    super({
      title: 'Microsoft AI',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new MicrosoftPlugin());
