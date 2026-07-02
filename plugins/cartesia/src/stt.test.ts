// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { STT } from './stt.js';

const hasCartesiaApiKey = Boolean(process.env.CARTESIA_API_KEY);

if (hasCartesiaApiKey) {
  describe('Cartesia STT', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Cartesia STT', () => {
    it.skip('requires CARTESIA_API_KEY', () => {});
  });
}
