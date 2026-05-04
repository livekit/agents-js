// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm as llmTest } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { LLM } from './llm.js';

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

if (hasMistralApiKey) {
  describe('Mistral LLM', async () => {
    await llmTest(new LLM({ temperature: 0 }), false);
  });
} else {
  describe('Mistral LLM', () => {
    it.skip('requires MISTRAL_API_KEY', () => {});
  });
}
