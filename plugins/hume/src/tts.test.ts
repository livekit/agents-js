// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasHumeConfig = Boolean(process.env.HUME_API_KEY && process.env.OPENAI_API_KEY);

if (hasHumeConfig) {
  describe('Hume TTS', async () => {
    await tts(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('Hume TTS', () => {
    it.skip('requires HUME_API_KEY and OPENAI_API_KEY', () => {});
  });
}
