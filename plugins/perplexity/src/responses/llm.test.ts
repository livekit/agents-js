// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import * as responses from './index.js';
import { LLM, PERPLEXITY_RESPONSES_BASE_URL } from './llm.js';

const originalPerplexityApiKey = process.env.PERPLEXITY_API_KEY;

interface LLMInternals {
  _client: OpenAI;
  _opts: {
    useWebSocket: boolean;
  };
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

describe('Perplexity Responses LLM', () => {
  it('defaults to sonar-pro, Perplexity Responses base URL, and HTTP transport', () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';

    const llm = new LLM();
    const internals = llm as unknown as LLMInternals;

    expect(llm.model).toBe('sonar-pro');
    expect(internals._opts.useWebSocket).toBe(false);
    expect(PERPLEXITY_RESPONSES_BASE_URL).toBe('https://api.perplexity.ai/v1');
    expect(internals._client.baseURL).toBe('https://api.perplexity.ai/v1');
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

  it('exports the responses submodule', () => {
    expect(responses.LLM).toBe(LLM);
  });
});
