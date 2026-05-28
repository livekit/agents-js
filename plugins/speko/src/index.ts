// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

/**
 * Speko STT, LLM, and TTS plugin for LiveKit Agents.
 *
 * @packageDocumentation
 */
export { framesToWav, parseWav, pcmSampleRateFromContentType } from './audio.js';
export { type SpekoClientOptions } from './client.js';
export type { Intent, OptimizeFor } from './intent.js';
export { validateIntent } from './intent.js';
export { chatContextToSpeko, LLM, SpekoPluginError, type LLMOptions } from './llm.js';
export { STT, type STTOptions } from './stt.js';
export { decodeSynthesisResult, TTS, type TTSOptions } from './tts.js';

class SpekoPlugin extends Plugin {
  constructor() {
    super({
      title: 'speko',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new SpekoPlugin());
