// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasResembleConfig = Boolean(process.env.RESEMBLE_API_KEY && process.env.OPENAI_API_KEY);

if (hasResembleConfig) {
  describe('Resemble', async () => {
    await tts(new TTS(), new STT());
  });
} else {
  describe('Resemble', () => {
    it.skip('requires RESEMBLE_API_KEY and OPENAI_API_KEY', () => {});
  });
}
