// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { STT } from './stt.js';

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

if (hasMistralApiKey) {
  describe('Mistral STT', { timeout: 30_000 }, async () => {
    await stt(new STT(), await VAD.load(), { streaming: false });
  });
} else {
  describe('Mistral STT', () => {
    it.skip('requires MISTRAL_API_KEY', () => {});
  });
}
