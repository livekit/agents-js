// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * as realtime from './realtime/index.js';

class BosonPlugin extends Plugin {
  constructor() {
    super({
      title: 'boson',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new BosonPlugin());
