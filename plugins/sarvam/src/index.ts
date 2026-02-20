// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './models.js';
export {
  STT,
  SpeechStream,
  type STTOptions,
  type STTV2Options,
  type STTTranslateOptions,
  type STTV3Options,
} from './stt.js';
export {
  ChunkedStream,
  SynthesizeStream,
  TTS,
  type TTSOptions,
  type TTSV2Options,
  type TTSV3Options,
} from './tts.js';

class SarvamPlugin extends Plugin {
  constructor() {
    super({
      title: 'sarvam',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new SarvamPlugin());
