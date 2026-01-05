// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { STTv2 } from './stt_v2.js';

describe('Deepgram STTv2 (Flux)', async () => {
  initializeLogger({ pretty: false });
  await stt(new STTv2(), await VAD.load(), { nonStreaming: false });
});
