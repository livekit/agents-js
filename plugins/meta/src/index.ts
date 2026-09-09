// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { STT, SpeechStream } from './stt.js';
export type { STTOptions, SpeechStreamOptions, WebSocketFactory } from './stt.js';

class MetaPlugin extends Plugin {
  constructor() {
    super({
      title: 'meta',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new MetaPlugin());
