// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './tts.js';

class NeurophonicPlugin extends Plugin {
  constructor() {
    super({
      title: 'neuphonic',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new NeurophonicPlugin());
