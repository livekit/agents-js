// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './tts.js';

class UpliftAIPlugin extends Plugin {
  constructor() {
    super({
      title: 'upliftai',
      version: '0.1.0',
      package: '@livekit/agents-plugin-upliftai',
    });
  }
}

Plugin.registerPlugin(new UpliftAIPlugin());
