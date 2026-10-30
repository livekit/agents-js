// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { SpeechStream, STT, type STTOptions } from './stt.js';
export { SynthesizeStream, TTS, type TTSOptions } from './tts.js';

class NVIDIAPlugin extends Plugin {
  constructor() {
    super({
      title: 'nvidia',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new NVIDIAPlugin());
