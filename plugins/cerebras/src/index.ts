// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { LLM } from './llm.js';
export type { LLMOptions } from './llm.js';
export type { CerebrasChatModels } from './models.js';

class CerebrasPlugin extends Plugin {
  constructor() {
    super({
      title: 'cerebras',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new CerebrasPlugin());
