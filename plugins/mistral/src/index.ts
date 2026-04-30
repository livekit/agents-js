// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * @deprecated Use `@livekit/agents-plugin-mistralai` instead. This package is a compatibility
 * wrapper and will be removed in a future release.
 */

import { Plugin } from '@livekit/agents';

console.warn(
  '[@livekit/agents-plugin-mistral] This package is deprecated. ' +
    'Please migrate to @livekit/agents-plugin-mistralai.',
);

export { LLM, LLMStream } from '@livekit/agents-plugin-mistralai';
export type { LLMOptions } from '@livekit/agents-plugin-mistralai';
export type { MistralChatModels } from '@livekit/agents-plugin-mistralai';

class MistralPlugin extends Plugin {
  constructor() {
    super({
      title: 'mistral',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new MistralPlugin());
