// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * `@livekit/agents-plugin-blaze`
 *
 * LiveKit Agent Framework plugin for Blaze AI services (STT, TTS, LLM).
 *
 * @example
 * ```typescript
 * import { STT, TTS, LLM } from '@livekit/agents-plugin-blaze';
 *
 * // Create plugins (reads BLAZE_* env vars automatically)
 * const stt = new STT({ language: 'vi' });
 * const tts = new TTS({ speakerId: 'speaker-1' });
 * const llm = new LLM({ botId: 'my-chatbot' });
 *
 * // Or with shared configuration
 * import type { BlazeConfig } from '@livekit/agents-plugin-blaze';
 * const config: BlazeConfig = { apiUrl: 'http://gateway:8080', authToken: 'tok' };
 * const stt2 = new STT({ config, language: 'vi' });
 * ```
 */
import { Plugin } from '@livekit/agents';

export { STT } from './stt.js';
export type { STTOptions } from './stt.js';

export { TTS, ChunkedStream, SynthesizeStream } from './tts.js';
export type { TTSOptions } from './tts.js';

export { LLM, LLMStream } from './llm.js';
export type { LLMOptions, BlazeDemographics } from './llm.js';

export type { BlazeConfig } from './config.js';

export type {
  BlazeTTSModel,
  BlazeLanguage,
  BlazeAudioFormat,
  BlazeGender,
  BlazeDemographics as BlazeDemographicsModel,
  BlazeSTTResponse,
  BlazeChatMessage,
  BlazeLLMData,
} from './models.js';

class BlazePlugin extends Plugin {
  constructor() {
    super({
      title: 'Blaze',
      version: '0.1.0',
      package: '@livekit/agents-plugin-blaze',
    });
  }
}

Plugin.registerPlugin(new BlazePlugin());
