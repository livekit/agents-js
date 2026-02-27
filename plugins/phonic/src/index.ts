// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * as realtime from './realtime/index.js';

class PhonicPlugin extends Plugin {
  constructor() {
    super({
      title: 'phonic',
      version: '0.1.0',
      package: '@livekit/agents-plugin-phonic',
    });
  }
}

Plugin.registerPlugin(new PhonicPlugin());
