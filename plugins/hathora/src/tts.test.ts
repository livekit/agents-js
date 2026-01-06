// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { STT } from './stt.js';
import { TTS } from './tts.js';

describe('Hathora', async () => {
  await tts(new TTS({
    model: 'hexgrad-kokoro-82m',
    baseURL: "https://model-marketplace-api-dev.fly.dev/inference/v1/tts",
  }), new STT({
    model: 'nvidia-parakeet-tdt-0.6b-v3',
    baseURL: "https://model-marketplace-api-dev.fly.dev/inference/v1/stt",
  }), { streaming: false });
});
