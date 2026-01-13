// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { TTS } from './tts.js';

describe('Inworld', async () => {
  await tts(new TTS(), new STT());
});
