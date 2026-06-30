// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { LLM, LLMStream, type LLMOptions } from './llm.js';
export * from './models.js';

class AnthropicPlugin extends Plugin {
  constructor() {
    super({
      title: 'anthropic',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new AnthropicPlugin());
