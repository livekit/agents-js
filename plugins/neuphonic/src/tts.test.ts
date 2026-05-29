// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasNeuphonicConfig = Boolean(process.env.NEUPHONIC_API_KEY && hasInferenceCredentials());

if (hasNeuphonicConfig) {
  describe('Neuphonic', async () => {
    await tts(new TTS());
  });
} else {
  describe('Neuphonic', () => {
    it.skip('requires NEUPHONIC_API_KEY and LiveKit cloud credentials', () => {});
  });
}
