// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { LLM } from './llm.js';

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

if (hasMistralApiKey) {
  describe('Mistral', async () => {
    await llm(new LLM({ temperature: 0 }), true);
  });
} else {
  describe('Mistral', () => {
    it.skip('requires MISTRAL_API_KEY', () => { });
  });
}
