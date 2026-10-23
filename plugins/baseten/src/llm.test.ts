// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm as agentsLLM } from '@livekit/agents';
import { llm as testLLM } from '@livekit/agents-plugins-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLM, supportsInlineInstructions } from './llm.js';

const PREAMBLE = 'You are a helpful assistant.';
const INSTRUCTIONS = 'Ask the caller for the year they were born.';
const INLINED = `<instructions>\n${INSTRUCTIONS}\n</instructions>`;

const INLINE_MODELS = ['Qwen/Qwen3.8-27B'];
const PASSTHROUGH_MODELS = [
  'openai/gpt-oss-120b',
  'zai-org/GLM-5.2',
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
  'deepseek-ai/DeepSeek-V3-0324',
  'moonshotai/Kimi-K2-Instruct',
  'google/gemma-4-31B-it',
  'Qwen/Qwen3.5-35B-A3B-FP8',
];

const streamResponse = `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sentMessages(
  model: string,
  chatCtx: agentsLLM.ChatContext,
  inlineMidConversationInstructions?: boolean,
): Promise<Record<string, unknown>[]> {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(streamResponse, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );

  const modelInstance = new LLM({
    model,
    apiKey: 'test',
    inlineMidConversationInstructions,
  });
  try {
    for await (const _chunk of modelInstance.chat({ chatCtx })) {
      // Consume the stream so the request is sent.
    }
  } finally {
    await modelInstance.aclose();
  }

  expect(requests).toHaveLength(1);
  return requests[0]!.messages as Record<string, unknown>[];
}

function perTurnContext(): agentsLLM.ChatContext {
  const chatCtx = new agentsLLM.ChatContext();
  chatCtx.addMessage({ role: 'system', content: PREAMBLE });
  chatCtx.addMessage({ role: 'assistant', content: 'Hello! How can I help you?' });
  chatCtx.addMessage({ role: 'user', content: "I'd like to refill my prescription." });
  chatCtx.addMessage({ role: 'system', content: INSTRUCTIONS });
  return chatCtx;
}

function toolContext(): agentsLLM.ChatContext {
  const chatCtx = new agentsLLM.ChatContext();
  chatCtx.addMessage({ role: 'system', content: PREAMBLE });
  chatCtx.addMessage({ role: 'user', content: "What's the weather in SF?" });
  chatCtx.items.push(
    agentsLLM.FunctionCall.create({
      callId: 'call_1',
      name: 'get_weather',
      args: '{"city": "SF"}',
    }),
  );
  chatCtx.items.push(
    agentsLLM.FunctionCallOutput.create({
      callId: 'call_1',
      name: 'get_weather',
      output: 'sunny',
      isError: false,
    }),
  );
  chatCtx.addMessage({ role: 'system', content: INSTRUCTIONS });
  return chatCtx;
}

function plainContext(): agentsLLM.ChatContext {
  const chatCtx = new agentsLLM.ChatContext();
  chatCtx.addMessage({ role: 'system', content: PREAMBLE });
  chatCtx.addMessage({ role: 'user', content: 'Hi!' });
  chatCtx.addMessage({ role: 'assistant', content: 'Hello! How can I help you?' });
  chatCtx.addMessage({ role: 'user', content: 'Tell me a joke.' });
  return chatCtx;
}

describe('Baseten inline mid-conversation instructions', () => {
  it.each([
    ['Qwen/Qwen3.8-27B', true],
    ['qwen/qwen3.8-27b', true],
    ['Qwen/Qwen3.5-122B-A10B', false],
    ['Qwen/Qwen3-235B-A22B-Instruct-2507', false],
    ['qwen3-dedicated', false],
    ['google/gemma-4-31B-it', false],
    ['openai/gpt-oss-120b', false],
    ['zai-org/GLM-5.2', false],
    ['meta-llama/Llama-4-Scout-17B-16E-Instruct', false],
    ['my-dedicated-model', false],
  ])('infers inline instructions for %s', (model, expected) => {
    expect(supportsInlineInstructions(model)).toBe(expected);
  });

  it.each(INLINE_MODELS)('inlines per-turn instructions for %s', async (model) => {
    const messages = await sentMessages(model, perTurnContext());

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'user',
      'user',
    ]);
    expect(messages[0]).toEqual({ role: 'system', content: PREAMBLE });
    expect(messages.at(-1)).toEqual({ role: 'user', content: INLINED });
  });

  it('preserves tool call history when inlining', async () => {
    const messages = await sentMessages('Qwen/Qwen3.8-27B', toolContext());

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    const toolCalls = messages[2]!.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0]!.id).toBe('call_1');
    expect((toolCalls[0]!.function as Record<string, unknown>).name).toBe('get_weather');
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' });
    expect(messages.at(-1)).toEqual({ role: 'user', content: INLINED });
  });

  it("does not mutate the caller's chat context", async () => {
    const chatCtx = perTurnContext();
    const snapshot = chatCtx.toJSON();

    await sentMessages('Qwen/Qwen3.8-27B', chatCtx);

    expect(chatCtx.toJSON()).toEqual(snapshot);
    expect(chatCtx.items.at(-1)).toMatchObject({ type: 'message', role: 'system' });
  });

  it('drops an empty mid-conversation system message when inlining', async () => {
    const chatCtx = new agentsLLM.ChatContext();
    chatCtx.addMessage({ role: 'system', content: PREAMBLE });
    chatCtx.addMessage({ role: 'user', content: 'Hi!' });
    chatCtx.addMessage({ role: 'system', content: '' });

    const messages = await sentMessages('Qwen/Qwen3.8-27B', chatCtx);

    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
  });

  it.each(PASSTHROUGH_MODELS)('passes through per-turn instructions for %s', async (model) => {
    const messages = await sentMessages(model, perTurnContext());

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'user',
      'system',
    ]);
    expect(messages[0]).toEqual({ role: 'system', content: PREAMBLE });
    expect(messages.at(-1)).toEqual({ role: 'system', content: INSTRUCTIONS });
  });

  it('passes through tool history for OpenAI-style models', async () => {
    const messages = await sentMessages('openai/gpt-oss-120b', toolContext());

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'system',
    ]);
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'sunny' });
  });

  it('serializes conversations without mid-system messages identically', async () => {
    const inlined = await sentMessages('Qwen/Qwen3.8-27B', plainContext());
    const passthrough = await sentMessages('openai/gpt-oss-120b', plainContext());

    expect(inlined).toEqual(passthrough);
    expect(inlined.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it.each(['google/gemma-4-31B-it', 'my-dedicated-model'])(
    'allows inlining to be enabled for %s',
    async (model) => {
      const messages = await sentMessages(model, perTurnContext(), true);

      expect(messages.map((message) => message.role)).toEqual([
        'system',
        'assistant',
        'user',
        'user',
      ]);
      expect(messages.at(-1)).toEqual({ role: 'user', content: INLINED });
    },
  );

  it('allows inlining to be disabled for a listed model', async () => {
    const messages = await sentMessages('Qwen/Qwen3.8-27B', perTurnContext(), false);

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'user',
      'system',
    ]);
    expect(messages.at(-1)).toEqual({ role: 'system', content: INSTRUCTIONS });
  });
});

const hasBasetenApiKey = Boolean(process.env.BASETEN_API_KEY);

if (hasBasetenApiKey) {
  describe('Baseten', async () => {
    await testLLM(
      new LLM({
        model: 'openai/gpt-4o-mini',
        temperature: 0,
      }),
      false,
    );
  });
} else {
  describe('Baseten', () => {
    it.skip('requires BASETEN_API_KEY', () => {});
  });
}
