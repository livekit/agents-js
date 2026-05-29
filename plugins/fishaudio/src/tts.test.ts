// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasFishAudioConfig = Boolean(process.env.FISH_API_KEY && hasInferenceCredentials());

if (hasFishAudioConfig) {
  describe('FishAudio', async () => {
    await tts(new TTS());
  });
} else {
  describe('FishAudio', () => {
    it.skip('requires FISH_API_KEY and LiveKit cloud credentials', () => {});
  });
}
