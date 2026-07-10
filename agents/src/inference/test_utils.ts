// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, it, vi } from 'vitest';
import type { LLM } from '../llm/llm.js';
import type { STT } from '../stt/stt.js';
import type { TTS } from '../tts/tts.js';
import type { VAD } from '../vad.js';

interface InferenceTestHarness {
  llm: (model: LLM, skipOptionalArgs: boolean) => Promise<void>;
  llmStrict: (model: LLM) => Promise<void>;
  stt: (
    model: STT,
    vad: VAD,
    supports?: Partial<{ streaming: boolean; nonStreaming: boolean }>,
  ) => Promise<void>;
  tts: (
    model: TTS,
    validationStt: STT,
    supports?: Partial<{ streaming: boolean; streamingValidationStt: boolean }>,
  ) => Promise<void>;
}

const hasLiveKitCredentials = () =>
  Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

export const describeLiveKitInference = (
  name: string,
  agentsModule: object,
  registerTests: (harness: InferenceTestHarness) => Promise<void>,
) => {
  if (hasLiveKitCredentials()) {
    describe(name, { timeout: 120_000 }, async () => {
      vi.doMock('@livekit/agents', () => agentsModule);
      // Import the shared harness source directly: declaring the test plugin as an agents
      // dependency would create a workspace cycle because the plugin already depends on agents.
      const testPackage = '../../../plugins/test/src/index.js';
      const harness: InferenceTestHarness = await import(/* @vite-ignore */ testPackage);
      await registerTests(harness);
    });
  } else {
    describe(name, () => {
      it.skip('requires LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET', () => {});
    });
  }
};
