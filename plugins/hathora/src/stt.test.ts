// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { STT } from './stt.js';

describe('Hathora', async () => {
  await stt(new STT({
    model: 'nvidia-parakeet-tdt-0.6b-v3',
    baseURL: "https://model-marketplace-api-dev.fly.dev/inference/v1/stt",
  }), await VAD.load(), { streaming: false });
});
