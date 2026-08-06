// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';

describe('OpenAI LLM prewarm', () => {
  it('lists models with the prewarm cancellation signal', async () => {
    let prewarmSignal: AbortSignal | undefined;
    const modelsList = vi.fn(async (options: { signal?: AbortSignal }) => {
      prewarmSignal = options.signal;
    });
    const client = {
      baseURL: 'https://api.openai.test/v1',
      models: { list: modelsList },
    } as unknown as OpenAI;
    const llm = new LLM({ model: 'gpt-4.1', client });

    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(modelsList).toHaveBeenCalledTimes(1);
    expect(prewarmSignal).toBeInstanceOf(AbortSignal);
    expect(prewarmSignal?.aborted).toBe(false);

    await llm.aclose();
    expect(prewarmSignal?.aborted).toBe(true);
  });
});

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

if (hasOpenAIApiKey) {
  describe('OpenAI', async () => {
    await llm(
      new LLM({
        temperature: 0,
      }),
      false,
    );
  });
} else {
  describe('OpenAI', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}

if (hasOpenAIApiKey) {
  describe('OpenAI strict tool schema', async () => {
    await llmStrict(
      new LLM({
        temperature: 0,
        strictToolSchema: true,
      }),
    );
  });
} else {
  describe('OpenAI strict tool schema', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
