// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { AvatarSession } from './avatar.js';
export type { AvatarSessionOptions, StartOptions } from './avatar.js';
export { ErrorType, SynthesiaError } from './errors.js';
export type { SynthesiaErrorOptions } from './errors.js';
export { AvatarConfig } from './types.js';
export type { AvatarConfigOptions } from './types.js';

class SynthesiaPlugin extends Plugin {
  constructor() {
    super({
      title: 'synthesia',
      version: __PACKAGE_VERSION__,
      package: '@livekit/agents-plugin-synthesia',
    });
  }
}

Plugin.registerPlugin(new SynthesiaPlugin());
