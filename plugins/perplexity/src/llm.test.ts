// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import { LLM, PERPLEXITY_BASE_URL } from './llm.js';

describe('Perplexity LLM', () => {
  const originalApiKey = process.env.PERPLEXITY_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.PERPLEXITY_API_KEY;
    } else {
      process.env.PERPLEXITY_API_KEY = originalApiKey;
    }
  });

  it('uses the default model and base URL', () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
    const model = new LLM();

    expect(model.model).toBe('sonar-pro');
    expect(PERPLEXITY_BASE_URL).toBe('https://api.perplexity.ai');
  });

  it('attaches the attribution header on chat requests', async () => {
    let capturedHeaders: Record<string, string> = {};
    const client = new OpenAI({ apiKey: 'test-key', baseURL: PERPLEXITY_BASE_URL });
    client.chat.completions.create = (async (_body: unknown, options?: unknown) => {
      capturedHeaders =
        (options as { headers?: Record<string, string> } | undefined)?.headers ?? {};

      return {
        async *[Symbol.asyncIterator]() {
          // no-op
        },
      };
    }) as unknown as typeof client.chat.completions.create;

    const stream = new LLM({ client }).chat({ chatCtx: new llm.ChatContext() });
    for await (const _chunk of stream) {
      void _chunk;
    }

    expect(capturedHeaders['X-Pplx-Integration']).toBe(`livekit-agents/${__PACKAGE_VERSION__}`);
  });

  it('throws when the API key is missing', () => {
    delete process.env.PERPLEXITY_API_KEY;

    expect(() => new LLM()).toThrow('PERPLEXITY_API_KEY');
  });

  it('sets the provider name', () => {
    process.env.PERPLEXITY_API_KEY = 'test-key';

    expect(new LLM().provider).toBe('Perplexity');
  });
});
