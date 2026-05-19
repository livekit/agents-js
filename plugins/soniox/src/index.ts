// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './models.js';
export {
  STT,
  SpeechStream,
  type ContextGeneralItem,
  type ContextObject,
  type ContextTranslationTerm,
  type STTOptions,
  type TranslationConfig,
} from './stt.js';
export { ChunkedStream, SynthesizeStream, TTS, type TTSOptions } from './tts.js';

class SonioxPlugin extends Plugin {
  constructor() {
    super({
      title: 'soniox',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new SonioxPlugin());
