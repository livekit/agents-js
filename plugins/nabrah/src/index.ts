// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { STT, SpeechStream, type NabrahRecognitionModel, type STTOptions } from './stt.js';

class NabrahPlugin extends Plugin {
  constructor() {
    super({
      title: 'nabrah',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new NabrahPlugin());
