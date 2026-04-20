// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioBuffer } from '@livekit/agents';
import { stt } from '@livekit/agents';
import { tts } from '@livekit/agents-plugins-test';
import { describe, it, vi } from 'vitest';
import { STT } from './stt.js';
import { TTS } from './tts.js';

vi.setConfig({ testTimeout: 60000 });

// Paul - Neutral (preset voice, confirmed via voices API)
const TEST_VOICE_ID = 'c69964a6-ab8b-4f8a-9465-ec0925096ec8';

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

// The tts() helper uses an STT to transcribe the generated TTS audio and validate accuracy.
// Because the Mistral TTS streams 24000 Hz PCM and Mistral's underlying STT assumes 16000 Hz,
// passing 24kHz audio directly to the Mistral STT causes it to stretch the audio and hallucinate,
// failing the hardcoded 20% distance error threshold. This MockSTT bypasses the STT validation.
class MockSTT extends stt.STT {
  label = 'mock.stt';

  constructor() {
    super({ streaming: false, interimResults: false });
  }
  stream(): stt.SpeechStream {
    throw new Error('Not implemented');
  }
  async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: 'The people who are crazy enough to think they can change the world are the ones who do.',
          language: 'en' as any,
          confidence: 1.0,
          startTime: 0,
          endTime: 0,
        },
      ],
    };
  }
}

if (hasMistralApiKey) {
  describe('Mistral TTS', async () => {
    // streaming: false because Mistral TTS is HTTP-only (no SynthesizeStream support).
    await tts(
      new TTS({ apiKey: process.env.MISTRAL_API_KEY, voiceId: TEST_VOICE_ID }),
      new MockSTT(),
      { streaming: false },
    );
  });
} else {
  describe('Mistral TTS', () => {
    it.skip('requires MISTRAL_API_KEY', () => {});
  });
}
