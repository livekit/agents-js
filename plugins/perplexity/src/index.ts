// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import * as responses from './responses/index.js';

export { LLM, PERPLEXITY_BASE_URL, type LLMOptions } from './llm.js';
export type { PerplexityChatModels, PerplexityResponsesModels } from './models.js';
export { responses };

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
