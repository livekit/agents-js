// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { LLM, LLMStream, type LLMOptions, buildToolConfig } from './llm.js';
export * from './models.js';
export { SpeechStream, STT, type STTOptions } from './stt.js';
export { ChunkedStream, TTS, type TTSOptions } from './tts.js';
export { type AwsCredentials, DEFAULT_REGION, resolveRegion } from './utils.js';

class AwsPlugin extends Plugin {
  constructor() {
    super({
      title: 'aws',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new AwsPlugin());
