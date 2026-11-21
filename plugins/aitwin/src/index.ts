// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export { mintAiTwinAuthToken } from './auth.js';
export { AiTwinSpeech, attachAiTwinSpeech } from './speech.js';
export {
  DEFAULT_TOPIC_SPEAK,
  type AiTwinSpeechOptions,
  type MintAiTwinAuthTokenOptions,
  type MintAiTwinAuthTokenResult,
} from './types.js';

class AiTwinPlugin extends Plugin {
  constructor() {
    super({
      title: 'aitwin',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new AiTwinPlugin());
