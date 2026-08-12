// SPDX-FileCopyrightText: 2026 Gandr
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './models.js';
export { ChunkedStream, TTS, type TTSOptions } from './tts.js';

class GandrPlugin extends Plugin {
  constructor() {
    super({
      title: 'gandr',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new GandrPlugin());