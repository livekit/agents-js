// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { LLM, PERPLEXITY_BASE_URL } from './llm.js';

const originalPerplexityApiKey = process.env.PERPLEXITY_API_KEY;

interface LLMInternals {
  _client: OpenAI;
}

interface OpenAIInternals {
  _options: {
    defaultHeaders?: Record<string, string>;
  };
}

afterEach(() => {
  if (originalPerplexityApiKey === undefined) {
    delete process.env.PERPLEXITY_API_KEY;
  } else {
    process.env.PERPLEXITY_API_KEY = originalPerplexityApiKey;
  }
});

describe('Perplexity LLM', () => {
  it('defaults to sonar-pro and Perplexity base URL', () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';

    const llm = new LLM();

    expect(llm.model).toBe('sonar-pro');
    expect(PERPLEXITY_BASE_URL).toBe('https://api.perplexity.ai');
    expect((llm as unknown as LLMInternals)._client.baseURL).toBe('https://api.perplexity.ai');
  });

  it('attaches the Perplexity attribution header', () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';

    const llm = new LLM();
    const client = (llm as unknown as LLMInternals)._client as unknown as OpenAIInternals;

    expect(client._options.defaultHeaders?.['X-Pplx-Integration']).toBe(
      `livekit-agents/${__PACKAGE_VERSION__}`,
    );
  });

  it('requires a Perplexity API key', () => {
    delete process.env.PERPLEXITY_API_KEY;

    expect(() => new LLM()).toThrow(/PERPLEXITY_API_KEY/);
  });

  it('uses Perplexity as provider', () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';

    expect(new LLM().provider).toBe('Perplexity');
  });
});
