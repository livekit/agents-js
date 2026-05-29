// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { VAD, VADStream } from './vad.js';

console.warn(
  '@livekit/agents-plugin-silero is deprecated and will be removed in v2.0. ' +
    'AgentSession now defaults to the bundled silero VAD (via @livekit/local-inference); ' +
    'drop the explicit `vad=` argument entirely, pass `vad: null` to opt out, or use ' +
    "`import { inference } from '@livekit/agents'; new inference.VAD({ model: 'silero', ... })` " +
    'to customise options.',
);

class SileroPlugin extends Plugin {
  constructor() {
    super({
      title: 'silero',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new SileroPlugin());
