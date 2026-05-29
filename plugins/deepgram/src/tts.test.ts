// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasDeepgramTtsConfig = Boolean(process.env.DEEPGRAM_API_KEY && hasInferenceCredentials());

if (hasDeepgramTtsConfig) {
  describe('Deepgram', async () => {
    await tts(new TTS());
  });
} else {
  describe('Deepgram', () => {
    it.skip('requires DEEPGRAM_API_KEY and LiveKit cloud credentials', () => {});
  });
}
