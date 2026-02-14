// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { STT } from './stt.js';

describe('Sarvam STT', async () => {
  const vad = await VAD.load();
  await stt(new STT(), vad, { streaming: false });
});
