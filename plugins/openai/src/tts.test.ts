// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, testutils, tts } from '@livekit/agents';
import { describe, it } from 'vitest';
import { basic } from '../../../agents/src/tokenize/index.js';
import { STT } from './stt.js';
import { TTS } from './tts.js';

describe('OpenAI', () => {
  describe('TTS', () => {
    const etts = new TTS();
    const stt = new STT();
    it('should properly synthesize text', async () => {
      initializeLogger({ pretty: false });
      await testutils.tts(etts, stt);
    });
    it('should properly stream synthesize text', async () => {
      initializeLogger({ pretty: false });
      await testutils.ttsStream(new tts.StreamAdapter(etts, new basic.SentenceTokenizer()), stt);
    });
  });
});
