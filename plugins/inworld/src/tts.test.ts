// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasInworldConfig = Boolean(process.env.INWORLD_API_KEY && process.env.OPENAI_API_KEY);

if (hasInworldConfig) {
  describe('Inworld', async () => {
    await tts(new TTS(), new STT());
  });
} else {
  describe('Inworld', () => {
    it.skip('requires INWORLD_API_KEY and OPENAI_API_KEY', () => {});
  });
}
