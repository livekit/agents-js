// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, it, vi } from 'vitest';
import { STT } from './stt.js';

vi.setConfig({ testTimeout: 20000 });

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

if (hasMistralApiKey) {
  describe('Mistral', async () => {
    // We pass `streaming: true` since our Mistral plugin natively supports websockets!
    await stt(new STT(), await VAD.load(), { streaming: true });
  });
} else {
  describe('Mistral', () => {
    it.skip('requires MISTRAL_API_KEY', () => {});
  });
}
