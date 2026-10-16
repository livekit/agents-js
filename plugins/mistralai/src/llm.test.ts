// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm as llmTest } from '@livekit/agents-plugins-test';
import type { Mistral } from '@mistralai/mistralai';
import { describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';

describe('Mistral LLM prewarm', () => {
  it('lists models with the prewarm cancellation signal', async () => {
    let prewarmSignal: AbortSignal | undefined;
    const modelsList = vi.fn(async (_request: undefined, options: { signal?: AbortSignal }) => {
      prewarmSignal = options.signal;
    });
    const client = {
      models: { list: modelsList },
    } as unknown as Mistral;
    const llm = new LLM({ client });

    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(modelsList).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(prewarmSignal?.aborted).toBe(false);

    await llm.aclose();
    expect(prewarmSignal?.aborted).toBe(true);
  });
});

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
