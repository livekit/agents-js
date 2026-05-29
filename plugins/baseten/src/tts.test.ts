// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasBasetenStreamingConfig = Boolean(
  process.env.BASETEN_API_KEY && process.env.BASETEN_MODEL_ENDPOINT && hasInferenceCredentials(),
);

if (hasBasetenStreamingConfig) {
  describe('Baseten', async () => {
    await tts(new TTS(), undefined, { streaming: false });
  });
} else {
  describe('Baseten', () => {
    it.skip('requires Baseten streaming credentials/config and LiveKit cloud credentials', () => {});
  });
}
