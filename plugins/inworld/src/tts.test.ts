// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasInworldConfig = Boolean(process.env.INWORLD_API_KEY && hasInferenceCredentials());

if (hasInworldConfig) {
  describe('Inworld', async () => {
    await tts(new TTS());
  });
} else {
  describe('Inworld', () => {
    it.skip('requires INWORLD_API_KEY and LiveKit cloud credentials', () => {});
  });
}
