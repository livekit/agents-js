// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_API_CONNECT_OPTIONS, llm, voice } from '@livekit/agents';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';

const response =
  'data: {"id":"chatcmpl-offline","object":"chat.completion.chunk","created":0,"model":"provider-model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
  'data: {"id":"chatcmpl-offline","object":"chat.completion.chunk","created":0,"model":"provider-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

function captureRequests() {
  const requests: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push((await new Request(input, init).json()) as Record<string, unknown>);
    return new Response(response, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const client = new OpenAI({
    apiKey: 'offline-test-key',
    baseURL: 'https://provider.invalid/v1',
    fetch,
  });
  return { client, requests, fetch };
}

async function reply(model: LLM, extraKwargs?: Record<string, unknown>): Promise<string> {
  const chatCtx = new llm.ChatContext();
  chatCtx.addMessage({ role: 'user', content: 'hello' });
  let text = '';
  for await (const chunk of model.chat({ chatCtx, extraKwargs })) {
    text += chunk.delta?.content ?? '';
  }
  return text;
}

describe('OpenAI-compatible persistent model options', () => {
  it('sends per-call provider options in the serialized request', async () => {
    const { client, requests } = captureRequests();
    const model = new LLM({ model: 'provider-model', client });
    try {
      expect(await reply(model, { enable_thinking: false })).toBe('ok');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: 'provider-model',
        enable_thinking: false,
        stream: true,
      });
    } finally {
      await model.aclose();
    }
  });

  it('sends constructor-level provider defaults on successive requests', async () => {
    const { client, requests } = captureRequests();
    const options = {
      model: 'provider-model',
      client,
      modelOptions: { enable_thinking: false },
    };
    const model = new LLM(options);
    try {
      expect(await reply(model)).toBe('ok');
      expect(await reply(model)).toBe('ok');
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ enable_thinking: false });
      expect(requests[1]).toMatchObject({ enable_thinking: false });
    } finally {
      await model.aclose();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('uses per-call generic overrides for one call without changing persistent defaults', async () => {
  const { client, requests } = captureRequests();
  const defaults = Object.freeze({ enable_thinking: false, vendor_budget: 0, vendor_null: null });
  const overrides = Object.freeze({ enable_thinking: true });
  const model = new LLM({ model: 'provider-model', client, modelOptions: defaults });
  try {
    await reply(model, overrides);
    await reply(model);
    expect(requests[0]).toMatchObject({
      enable_thinking: true,
      vendor_budget: 0,
      vendor_null: null,
    });
    expect(requests[1]).toMatchObject({
      enable_thinking: false,
      vendor_budget: 0,
      vendor_null: null,
    });
    expect(defaults).toEqual({ enable_thinking: false, vendor_budget: 0, vendor_null: null });
    expect(overrides).toEqual({ enable_thinking: true });
  } finally {
    await model.aclose();
  }
});

it('keeps typed options and per-call tool choice authoritative over generic options', async () => {
  const { client, requests } = captureRequests();
  const model = new LLM({
    model: 'provider-model',
    client,
    topP: 0.2,
    toolChoice: 'auto',
    parallelToolCalls: false,
    modelOptions: { top_p: 0.9, tool_choice: 'auto', parallel_tool_calls: true },
  });
  const chatCtx = new llm.ChatContext();
  chatCtx.addMessage({ role: 'user', content: 'hello' });
  const toolCtx = new llm.ToolContext({
    test: llm.tool({ description: 'A test tool', execute: async () => 'ok' }),
  });
  try {
    const stream = model.chat({
      chatCtx,
      toolCtx,
      toolChoice: 'none',
      extraKwargs: { top_p: 0.8, parallel_tool_calls: true },
    });
    for await (const _chunk of stream) {
      // Drain the real stream so the SDK request and cleanup finish.
    }
    expect(requests[0]).toMatchObject({
      top_p: 0.2,
      tool_choice: 'none',
      parallel_tool_calls: false,
    });
  } finally {
    await model.aclose();
  }
});

it('shallowly replaces nested options and preserves existing extra_body precedence', async () => {
  const { client, requests } = captureRequests();
  const model = new LLM({
    model: 'provider-model',
    client,
    topP: 0.2,
    modelOptions: {
      vendor_options: { first: true, retained: true },
      extra_body: { top_p: 0.7 },
    },
  });
  try {
    await reply(model, { vendor_options: { first: false } });
    expect(requests[0]).toMatchObject({ vendor_options: { first: false }, top_p: 0.7 });
    expect(requests[0]?.vendor_options).toEqual({ first: false });
    expect(requests[0]).not.toHaveProperty('extra_body');
  } finally {
    await model.aclose();
  }
});

it('snapshots top-level defaults and keeps separate model instances independent', async () => {
  const first = captureRequests();
  const second = captureRequests();
  const defaults = { enable_thinking: false };
  const a = new LLM({ model: 'provider-model', client: first.client, modelOptions: defaults });
  const b = new LLM({ model: 'provider-model', client: second.client });
  defaults.enable_thinking = true;
  try {
    await reply(a);
    await reply(b);
    expect(first.requests[0]).toHaveProperty('enable_thinking', false);
    expect(second.requests[0]).not.toHaveProperty('enable_thinking');
  } finally {
    await Promise.all([a.aclose(), b.aclose()]);
  }
});

const helpers = {
  Cerebras: LLM.withCerebras,
  Fireworks: LLM.withFireworks,
  XAI: LLM.withXAI,
  Groq: LLM.withGroq,
  DeepSeek: LLM.withDeepSeek,
  Octo: LLM.withOcto,
  Ollama: LLM.withOllama,
  Perplexity: LLM.withPerplexity,
  Together: LLM.withTogether,
  Telnyx: LLM.withTelnyx,
  Meta: LLM.withMeta,
  OVHcloud: LLM.withOVHcloud,
};

it.each(Object.entries(helpers))(
  'forwards persistent provider options through %s',
  async (_name, factory) => {
    const { client, requests } = captureRequests();
    const options = {
      model: 'provider-model',
      apiKey: 'offline-test-key',
      client,
      modelOptions: { enable_thinking: false },
    };
    const model = factory(options);
    try {
      await reply(model);
      expect(requests[0]).toHaveProperty('enable_thinking', false);
    } finally {
      await model.aclose();
    }
  },
);

it('forwards Azure options to the request rather than only to the SDK client', async () => {
  const { fetch, requests } = captureRequests();
  vi.stubGlobal('fetch', fetch);
  const model = LLM.withAzure({
    model: 'provider-model',
    apiKey: 'offline-test-key',
    baseURL: 'https://azure.invalid/openai/deployments/test-deployment',
    azureDeployment: 'test-deployment',
    apiVersion: '2024-10-21',
    modelOptions: { enable_thinking: false },
  });
  try {
    await reply(model);
    expect(requests[0]).toHaveProperty('enable_thinking', false);
  } finally {
    await model.aclose();
  }
});

it('retains configured provider options through the default agent LLM node', async () => {
  const { client, requests } = captureRequests();
  const model = new LLM({
    model: 'provider-model',
    client,
    modelOptions: { enable_thinking: false },
  });
  const agent = new voice.Agent({ instructions: 'Be helpful', llm: model });
  // Supply only the runtime context needed by the real default node; no room/audio is started.
  const activity = {
    llm: model,
    agentSession: { connOptions: { llmConnOptions: DEFAULT_API_CONNECT_OPTIONS } },
  } as unknown as ReturnType<typeof agent.getActivityOrThrow>;
  const activitySpy = vi.spyOn(agent, 'getActivityOrThrow').mockReturnValue(activity);
  const chatCtx = new llm.ChatContext();
  chatCtx.addMessage({ role: 'user', content: 'hello' });
  try {
    const output = await agent.llmNode(chatCtx, new llm.ToolContext(), { toolChoice: 'auto' });
    expect(output).not.toBeNull();
    const reader = output!.getReader();
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (typeof value === 'string') text += value;
        else if (typeof value === 'object') text += value.delta?.content ?? '';
      }
    } finally {
      reader.releaseLock();
    }
    expect(text).toBe('ok');
    expect(requests[0]).toHaveProperty('enable_thinking', false);
  } finally {
    activitySpy.mockRestore();
    await model.aclose();
  }
});
