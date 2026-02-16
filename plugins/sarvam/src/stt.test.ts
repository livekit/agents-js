// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { STT } from './stt.js';

const hasSarvamApiKey = Boolean(process.env.SARVAM_API_KEY);

describe('Sarvam STT', () => {
  it.skipIf(!hasSarvamApiKey)('runs integration suite with real API key', async () => {
    const vad = await VAD.load();
    await stt(new STT({ apiKey: process.env.SARVAM_API_KEY }), vad, { streaming: false });
  });

  it('supports opting into non-streaming mode', () => {
    const nonStreamingStt = new STT({ apiKey: 'dummy-api-key', streaming: false });

    expect(nonStreamingStt.capabilities.streaming).toBe(false);
    expect(() => nonStreamingStt.stream()).toThrow(/streaming is disabled/i);
  });
});
