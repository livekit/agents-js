// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-deepgram';
import { tts } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { TTS } from './tts.js';

describe('Deepgram', async () => {
  await tts(new TTS(), new STT());
});
