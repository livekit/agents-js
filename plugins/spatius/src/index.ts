// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { AudioFormat } from '@spatius/server-sdk';
export * from './avatar.js';
export * from './warmup.js';

class SpatiusPlugin extends Plugin {
  constructor() {
    super({ title: 'spatius', version: __PACKAGE_VERSION__, package: __PACKAGE_NAME__ });
  }
}
Plugin.registerPlugin(new SpatiusPlugin());
