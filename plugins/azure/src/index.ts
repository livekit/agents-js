// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export * from './stt.js';
export * from './decision_model.js';

class AzurePlugin extends Plugin {
  constructor() {
    super({
      title: 'azure',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new AzurePlugin());
