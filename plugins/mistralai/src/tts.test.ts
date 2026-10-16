// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { STT } from './stt.js';
import { TTS } from './tts.js';

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

if (hasMistralApiKey) {
  describe('Mistral TTS', async () => {
    await tts(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('Mistral TTS', () => {
    it.skip('requires MISTRAL_API_KEY', () => {});
  });
}
