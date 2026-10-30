// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './models.js';
export * from './stt.js';
export * from './tts.js';

class SmallestAIPlugin extends Plugin {
  constructor() {
    super({
      title: 'smallestai',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new SmallestAIPlugin());
