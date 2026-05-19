// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import { afterEach, describe, expect, it } from 'vitest';
import { LLM, PERPLEXITY_RESPONSES_BASE_URL } from './llm.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);
const originalPerplexityApiKey = process.env.PERPLEXITY_API_KEY;

afterEach(() => {
  if (originalPerplexityApiKey === undefined) {
    delete process.env.PERPLEXITY_API_KEY;
  } else {
    process.env.PERPLEXITY_API_KEY = originalPerplexityApiKey;
  }
});

describe('Perplexity Responses options', () => {
  it('defaults to sonar-pro over HTTP Responses transport', () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';

    const perplexity = LLM.withPerplexity();

    expect(perplexity.model).toBe('sonar-pro');
    expect(perplexity.label()).toBe('openai.responses.LLM');
    expect(PERPLEXITY_RESPONSES_BASE_URL).toBe('https://api.perplexity.ai/v1');
  });

  it('requires a Perplexity API key', () => {
    delete process.env.PERPLEXITY_API_KEY;

    expect(() => LLM.withPerplexity()).toThrow(/PERPLEXITY_API_KEY/);
  });
});

if (hasOpenAIApiKey) {
  describe('OpenAI Responses', async () => {
    await llm(
      new LLM({
        temperature: 0,
        strictToolSchema: false,
      }),
      true,
    );
  });
} else {
  describe('OpenAI Responses', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}

if (hasOpenAIApiKey) {
  describe('OpenAI Responses strict tool schema', async () => {
    await llmStrict(
      new LLM({
        temperature: 0,
        strictToolSchema: true,
      }),
    );
  });
} else {
  describe('OpenAI Responses strict tool schema', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
