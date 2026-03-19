// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasRimeConfig = Boolean(process.env.RIME_API_KEY && process.env.OPENAI_API_KEY);

if (hasRimeConfig) {
  describe('Rime TTS', async () => {
    await tts(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('Rime TTS', () => {
    it.skip('requires RIME_API_KEY and OPENAI_API_KEY', () => {});
  });
}
