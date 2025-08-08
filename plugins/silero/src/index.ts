// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { VAD, VADStream } from './vad.js';

class SileroPlugin extends Plugin {
  constructor() {
    super({
      title: 'silero',
      version: '0.5.6',
      package: '@livekit/agents-plugin-silero',
    });
  }
}

Plugin.registerPlugin(new SileroPlugin());
