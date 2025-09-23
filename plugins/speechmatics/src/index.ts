// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './stt.js';

class SpeechmaticsPlugin extends Plugin {
  constructor() {
    super({
      title: 'speechmatics',
      version: '0.1.3',
      package: '@livekit/agents-plugin-speechmatics',
    });
  }
}

Plugin.registerPlugin(new SpeechmaticsPlugin());
