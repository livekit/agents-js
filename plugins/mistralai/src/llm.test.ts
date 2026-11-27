// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { llm as llmTest } from '@livekit/agents-plugins-test';
import type { Mistral } from '@mistralai/mistralai';
import type { ConversationEvents } from '@mistralai/mistralai/models/components';
import { describe, expect, it, vi } from 'vitest';
import { LLM, type LLMOptions } from './llm.js';

function createModel(
  opts: Omit<LLMOptions, 'apiKey' | 'client' | 'model'> = {},
  events: ConversationEvents[] = [],
) {
  const requests: Record<string, unknown>[] = [];
  const startStream = vi.fn(async (request: Record<string, unknown>) => {
    requests.push(request);
    return (async function* () {
      yield* events;
    })();
  });
  const client = {
    beta: { conversations: { startStream } },
  } as unknown as Mistral;

  return { model: new LLM({ client, model: 'test-model', ...opts }), requests };
}

async function run(model: LLM, extraKwargs?: Record<string, unknown>) {
  await model.chat({ chatCtx: llm.ChatContext.empty(), extraKwargs }).collect();
}

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

describe('Mistral LLM store', () => {
  it('does not send store by default', async () => {
    const { model, requests } = createModel();

    try {
      await run(model);
      expect(requests[0]).not.toHaveProperty('store');
    } finally {
      await model.aclose();
    }
  });

  it('sends store with each request', async () => {
    const { model, requests } = createModel({ store: false });

    try {
      await run(model);
      expect(requests[0]?.store).toBe(false);
    } finally {
      await model.aclose();
    }
  });

  it('updates store through updateOptions', async () => {
    const { model, requests } = createModel();

    try {
      model.updateOptions({ store: false });
      await run(model);
      model.updateOptions({ store: true });
      await run(model);
      expect(requests.map((request) => request.store)).toEqual([false, true]);
    } finally {
      await model.aclose();
    }
  });

  it('allows extraKwargs to override store', async () => {
    const { model, requests } = createModel({ store: false });

    try {
      await run(model, { store: true });
      expect(requests[0]?.store).toBe(true);
    } finally {
      await model.aclose();
    }
  });
});

describe('Mistral LLM reasoning effort', () => {
  it('does not send reasoning effort by default', async () => {
    const { model, requests } = createModel();

    try {
      await run(model);
      expect(requests[0]).not.toHaveProperty('completionArgs');
    } finally {
      await model.aclose();
    }
  });

  it('sends reasoning effort in completion args', async () => {
    const { model, requests } = createModel({ reasoningEffort: 'none' });

    try {
      await run(model);
      expect(requests[0]?.completionArgs).toMatchObject({ reasoningEffort: 'none' });
    } finally {
      await model.aclose();
    }
  });

  it('updates reasoning effort through updateOptions', async () => {
    const { model, requests } = createModel();

    try {
      model.updateOptions({ reasoningEffort: 'none' });
      await run(model);
      model.updateOptions({ reasoningEffort: 'high' });
      await run(model);
      expect(
        requests.map(
          (request) => (request.completionArgs as { reasoningEffort: string }).reasoningEffort,
        ),
      ).toEqual(['none', 'high']);
    } finally {
      await model.aclose();
    }
  });

  it('sends reasoning effort with other completion args', async () => {
    const { model, requests } = createModel({ temperature: 0.2, reasoningEffort: 'high' });

    try {
      await run(model);
      expect(requests[0]?.completionArgs).toMatchObject({
        temperature: 0.2,
        reasoningEffort: 'high',
      });
    } finally {
      await model.aclose();
    }
  });

  it('does not emit thinking chunks', async () => {
    const events = [
      {
        event: 'message.output.delta',
        data: {
          type: 'message.output.delta',
          outputIndex: 0,
          id: 'msg_1',
          contentIndex: 0,
          role: 'assistant',
          content: { type: 'thinking', thinking: [{ type: 'text', text: 'let me think' }] },
        },
      },
      {
        event: 'message.output.delta',
        data: {
          type: 'message.output.delta',
          outputIndex: 0,
          id: 'msg_1',
          contentIndex: 0,
          role: 'assistant',
          content: 'Hello',
        },
      },
    ] as ConversationEvents[];
    const { model } = createModel({ reasoningEffort: 'high' }, events);

    try {
      const response = await model.chat({ chatCtx: llm.ChatContext.empty() }).collect();
      expect(response.text).toBe('Hello');
    } finally {
      await model.aclose();
    }
  });

  it('merges extra completion args', async () => {
    const { model, requests } = createModel({ reasoningEffort: 'high' });

    try {
      await run(model, { completionArgs: { maxTokens: 50 } });
      expect(requests[0]?.completionArgs).toMatchObject({
        maxTokens: 50,
        reasoningEffort: 'high',
      });
    } finally {
      await model.aclose();
    }
  });

  it('gives extra completion args precedence', async () => {
    const { model, requests } = createModel({ temperature: 0.2, reasoningEffort: 'high' });

    try {
      await run(model, { completionArgs: { reasoningEffort: 'none' } });
      expect(requests[0]?.completionArgs).toMatchObject({
        temperature: 0.2,
        reasoningEffort: 'none',
      });
    } finally {
      await model.aclose();
    }
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
