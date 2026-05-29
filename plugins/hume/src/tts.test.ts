// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasHumeConfig = Boolean(process.env.HUME_API_KEY && hasInferenceCredentials());

if (hasHumeConfig) {
  describe('Hume TTS', async () => {
    await tts(new TTS(), undefined, { streaming: false });
  });
} else {
  describe('Hume TTS', () => {
    it.skip('requires HUME_API_KEY and LiveKit cloud credentials', () => {});
  });
}
