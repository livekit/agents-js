// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './llm.js';
export * from './stt.js';
export * from './tts.js';
export * from './models.js';

class MistralPlugin extends Plugin {
  constructor() {
    super({
      title: 'mistral',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new MistralPlugin());
