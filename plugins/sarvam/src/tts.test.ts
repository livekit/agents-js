// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { TTS } from './tts.js';

const hasSarvamApiKey = Boolean(process.env.SARVAM_API_KEY);

describe('Sarvam TTS', () => {
  it.skipIf(!hasSarvamApiKey)('runs integration suite with real API key', async () => {
    await tts(new TTS({ apiKey: process.env.SARVAM_API_KEY }), new STT(), { streaming: false });
  });

  it('supports opting into non-streaming mode', () => {
    const nonStreamingTts = new TTS({ apiKey: 'dummy-api-key', streaming: false });

    expect(nonStreamingTts.capabilities.streaming).toBe(false);
    expect(() => nonStreamingTts.stream()).toThrow(/streaming is disabled/i);
  });
});
