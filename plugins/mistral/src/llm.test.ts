// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm as llmTest } from '@livekit/agents-plugins-test';
import { describe, it, vi } from 'vitest';
import { LLM } from './llm.js';

vi.setConfig({ testTimeout: 30000 });

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

if (hasMistralApiKey) {
  describe('Mistral LLM integration', async () => {
    await llmTest(new LLM({ temperature: 0 }), true);
  });
} else {
  describe('Mistral LLM integration', () => {
    it.skip('requires MISTRAL_API_KEY', () => {});
  });
}
