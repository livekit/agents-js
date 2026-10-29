// SPDX-FileCopyrightText: 2026 OpenSpline contributors
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { AvatarSession, type AvatarSessionOptions } from './avatar.js';

class OpensplinePlugin extends Plugin {
  constructor() {
    super({
      title: 'openspline',
      version: __PACKAGE_VERSION__,
      package: '@livekit/agents-plugin-openspline',
    });
  }
}
Plugin.registerPlugin(new OpensplinePlugin());
