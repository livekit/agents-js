// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasCartesiaConfig = Boolean(process.env.CARTESIA_API_KEY && hasInferenceCredentials());

if (hasCartesiaConfig) {
  describe('Cartesia', async () => {
    await tts(new TTS());
  });
} else {
  describe('Cartesia', () => {
    it.skip('requires CARTESIA_API_KEY and LiveKit cloud credentials', () => {});
  });
}
