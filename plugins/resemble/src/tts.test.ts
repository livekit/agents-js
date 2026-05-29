// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasResembleConfig = Boolean(process.env.RESEMBLE_API_KEY && hasInferenceCredentials());

if (hasResembleConfig) {
  describe('Resemble', async () => {
    await tts(new TTS());
  });
} else {
  describe('Resemble', () => {
    it.skip('requires RESEMBLE_API_KEY and LiveKit cloud credentials', () => {});
  });
}
