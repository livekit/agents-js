// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import './tts.js';

export * from './tts.js';

class InworldPlugin extends Plugin {
  constructor() {
    super({
      title: 'Inworld',
      version: __PACKAGE_VERSION__,
      package: '@livekit/agents-plugin-inworld',
    });
  }
}

Plugin.registerPlugin(new InworldPlugin());
