// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { STT, SpeechStream, type STTOptions } from './stt.js';
export { ChunkedStream, SynthesizeStream, TTS, type TTSOptions } from './tts.js';

class GradiumPlugin extends Plugin {
  constructor() {
    super({
      title: 'gradium',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new GradiumPlugin());
