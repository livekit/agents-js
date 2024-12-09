// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-test';
import { describe } from 'vitest';
import { TTS } from './tts.js';

describe('ElevenLabs', async () => {
  await tts(new TTS(), new STT(), { nonStreaming: false });
});
