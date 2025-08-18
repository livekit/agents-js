// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './tts.js';

class CartesiaPlugin extends Plugin {
  constructor() {
    super({
      title: 'cartesia',
      version: '0.1.3',
      package: '@livekit/agents-plugin-cartesia',
    });
  }
}

Plugin.registerPlugin(new CartesiaPlugin());
