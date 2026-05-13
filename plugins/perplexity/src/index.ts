// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { LLM, PERPLEXITY_BASE_URL } from './llm.js';
export type { LLMOptions } from './llm.js';
export type { PerplexityChatModels } from './models.js';

class PerplexityPlugin extends Plugin {
  constructor() {
    super({
      title: 'perplexity',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new PerplexityPlugin());
