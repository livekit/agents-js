// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * LiveKit Agents Baseten Plugin
 *
 * Integrates Baseten-hosted models with LiveKit Agents for LLM, STT, and TTS services.
 */
import { Plugin } from '@livekit/agents';

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

// Export classes following LiveKit plugin pattern
export { LLM } from './llm.js';
export { STT } from './stt.js';
export { TTS } from './tts.js';

// Export all types
export type { BasetenLLMOptions, BasetenSttOptions, BasetenTTSOptions } from './types.js';
