// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { type AvatarInfo, type BosonAvatarAPIOptions, listAvatars } from './api.js';
export { AvatarSession, type AvatarSessionOptions, type StartOptions } from './avatar.js';
export { BosonAvatarException } from './errors.js';

class BosonAvatarPlugin extends Plugin {
  constructor() {
    super({
      title: 'boson-avatar',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new BosonAvatarPlugin());
