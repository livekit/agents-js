// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './models.js';
export { ChunkedStream, SynthesizeStream, TTS, type TTSOptions } from './tts.js';

class GoogleCloudPlugin extends Plugin {
  constructor() {
    super({
      title: 'google-cloud',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new GoogleCloudPlugin());
