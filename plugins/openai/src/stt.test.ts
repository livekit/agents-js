// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { STT } from './stt.js';

describe('OpenAI', async () => {
  await stt(new STT(), await VAD.load(), { streaming: false });
});
