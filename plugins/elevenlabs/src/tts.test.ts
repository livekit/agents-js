// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, testutils } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

describe('ElevenLabs', () => {
  describe('TTS', () => {
    const tts = new TTS();
    const stt = new STT();
    it('should properly stream synthesize text', async () => {
      initializeLogger({ pretty: false });
      await testutils.ttsStream(tts, stt);
    });
  });
});
