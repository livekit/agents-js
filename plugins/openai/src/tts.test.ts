// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasOpenAIConfig = Boolean(process.env.OPENAI_API_KEY && hasInferenceCredentials());

if (hasOpenAIConfig) {
  describe('OpenAI', async () => {
    await tts(new TTS(), undefined, { streaming: false });
  });
} else {
  describe('OpenAI', () => {
    it.skip('requires OPENAI_API_KEY and LiveKit cloud credentials', () => {});
  });
}
