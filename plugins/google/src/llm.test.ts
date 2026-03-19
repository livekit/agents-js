// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents-plugins-test';
import { describe, it } from 'vitest';
import { LLM } from './llm.js';

const hasGoogleApiKey = Boolean(process.env.GOOGLE_API_KEY);

if (hasGoogleApiKey) {
  describe('Google', async () => {
    await llm(
      new LLM({
        model: 'gemini-2.5-flash',
        temperature: 0,
      }),
      true,
    );
  });
} else {
  describe('Google', () => {
    it.skip('requires GOOGLE_API_KEY', () => {});
  });
}
