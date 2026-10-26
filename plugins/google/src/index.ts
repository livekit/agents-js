// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import * as beta from './beta/index.js';
import * as realtime from './realtime/index.js';

export {
  AIPlatformLLM,
  type AccessTokenProvider,
  type AIPlatformLLMOptions,
  type ApiVersion,
  type GoogleCredentials,
} from './aiplatform_llm.js';
export { beta };
export { LLM, LLMStream, type LLMOptions } from './llm.js';
export * from './models.js';
export * from './tools.js';
export { realtime };

class GooglePlugin extends Plugin {
  constructor() {
    super({
      title: 'google',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new GooglePlugin());
