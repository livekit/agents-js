// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { LLM } from './llm.js';
export { STT } from './stt.js';
export { TTS, ChunkedStream } from './tts.js';
export type { BasetenLLMOptions, BasetenSttOptions, BasetenTTSOptions } from './types.js';
class BasetenPlugin extends Plugin {
  constructor() {
    super({
      title: 'baseten',
      version: '1.0.0',
      package: 'livekit-plugin-baseten',
    });
  }
}

Plugin.registerPlugin(new BasetenPlugin());
