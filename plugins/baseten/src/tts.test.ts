// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { STT } from './stt.js';
import { TTS } from './tts.js';

const hasBasetenStreamingConfig = Boolean(
  process.env.BASETEN_API_KEY && process.env.BASETEN_MODEL_ENDPOINT,
);

if (hasBasetenStreamingConfig) {
  describe('Baseten', async () => {
    await tts(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('Baseten', () => {
    it.skip('requires Baseten streaming credentials/config', () => {});
  });
}
