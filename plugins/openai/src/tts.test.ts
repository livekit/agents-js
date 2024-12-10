// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { STT } from './stt.js';
import { TTS } from './tts.js';

describe('OpenAI', async () => {
  await tts(new TTS(), new STT(), { streaming: false });
});
