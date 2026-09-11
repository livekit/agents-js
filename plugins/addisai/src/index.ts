// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

/**
 * AddisAI speech-to-text and text-to-speech for LiveKit Agents.
 *
 * @packageDocumentation
 */
export * from './models.js';
export * from './stt.js';
export * from './tts.js';

class AddisAIPlugin extends Plugin {
  constructor() {
    super({
      title: 'addisai',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new AddisAIPlugin());
