// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * as realtime from './realtime/index.js';

class XAIPlugin extends Plugin {
  constructor() {
    super({
      title: 'xai',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new XAIPlugin());
