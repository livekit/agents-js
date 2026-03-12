// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasCartesiaConfig = Boolean(process.env.CARTESIA_API_KEY && process.env.OPENAI_API_KEY);

if (hasCartesiaConfig) {
  describe('Cartesia', async () => {
    await tts(new TTS(), new STT());
  });
} else {
  describe('Cartesia', () => {
    it.skip('requires CARTESIA_API_KEY and OPENAI_API_KEY', () => {});
  });
}
