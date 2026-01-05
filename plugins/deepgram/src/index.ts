// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './stt.js';
export * from './stt_v2.js';
export * from './tts.js';

class DeepgramPlugin extends Plugin {
  constructor() {
    super({
      title: 'deepgram',
      version: '0.5.6',
      package: '@livekit/agents-plugin-deepgram',
    });
  }
}

Plugin.registerPlugin(new DeepgramPlugin());
