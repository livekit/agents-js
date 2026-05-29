// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasMistralConfig = Boolean(process.env.MISTRAL_API_KEY && hasInferenceCredentials());

if (hasMistralConfig) {
  describe('Mistral TTS', async () => {
    await tts(new TTS(), undefined, { streaming: false });
  });
} else {
  describe('Mistral TTS', () => {
    it.skip('requires MISTRAL_API_KEY and LiveKit cloud credentials', () => {});
  });
}
