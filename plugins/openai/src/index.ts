// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { LLM, LLMStream, type LLMOptions } from './llm.js';
export * from './models.js';
export * as realtime from './realtime/index.js';
export * as responses from './responses/index.js';
export { STT, type STTOptions } from './stt.js';
export { ChunkedStream, TTS, type TTSOptions } from './tts.js';

class OpenAIPlugin extends Plugin {
  constructor() {
    super({
      title: 'openai',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new OpenAIPlugin());
