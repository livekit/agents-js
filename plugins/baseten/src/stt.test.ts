// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { STT } from './stt.js';

const hasBasetenStreamingConfig = Boolean(
  process.env.BASETEN_API_KEY &&
    (process.env.BASETEN_MODEL_ENDPOINT || process.env.BASETEN_STT_MODEL_ID),
);

if (hasBasetenStreamingConfig) {
  describe('Baseten', async () => {
    await stt(new STT(), await VAD.load(), { streaming: true });
  });
} else {
  describe('Baseten', () => {
    it.skip('requires Baseten streaming credentials/config', () => {});
  });
}
