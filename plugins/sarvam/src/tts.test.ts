// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { hasInferenceCredentials, tts } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { TTS } from './tts.js';

const hasSarvamConfig = Boolean(process.env.SARVAM_API_KEY && hasInferenceCredentials());

describe('Sarvam TTS', () => {
  it.skipIf(!hasSarvamConfig)('runs integration suite with real API key', async () => {
    await tts(new TTS({ apiKey: process.env.SARVAM_API_KEY }), undefined, { streaming: false });
  });

  it('supports opting into non-streaming mode', () => {
    const nonStreamingTts = new TTS({ apiKey: 'dummy-api-key', streaming: false });

    expect(nonStreamingTts.capabilities.streaming).toBe(false);
    expect(() => nonStreamingTts.stream()).toThrow(/streaming is disabled/i);
  });
});
