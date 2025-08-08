// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * as beta from './beta/index.js';
export { LLM, LLMStream, type LLMOptions } from './llm.js';
export * from './models.js';

class GooglePlugin extends Plugin {
  constructor() {
    super({
      title: 'google',
      version: '0.1.0',
      package: '@livekit/agents-plugin-google',
    });
  }
}

Plugin.registerPlugin(new GooglePlugin());
