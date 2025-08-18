// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { LLM, LLMStream, type LLMOptions } from './llm.js';
export * from './models.js';
export * as realtime from './realtime/index.js';
export { STT, type STTOptions } from './stt.js';
export { ChunkedStream, TTS, type TTSOptions } from './tts.js';

class OpenAIPlugin extends Plugin {
  constructor() {
    super({
      title: 'openai',
      version: '0.9.1',
      package: '@livekit/agents-plugin-openai',
    });
  }
}

Plugin.registerPlugin(new OpenAIPlugin());
