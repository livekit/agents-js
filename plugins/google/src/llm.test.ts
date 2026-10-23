// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { LLM } from './llm.js';

const hasGoogleApiKey = Boolean(process.env.GOOGLE_API_KEY);

it('defaults to a model that has not been retired', () => {
  // gemini-2.5-* stopped being served on Vertex AI on 2026-10-20
  const retired = new Set([
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
  ]);

  expect(retired.has(new LLM({ apiKey: 'test-key' }).model)).toBe(false);
});

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
