// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import Anthropic from '@anthropic-ai/sdk';
import { llm, log } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LLM } from './llm.js';

const { anthropicConstructor } = vi.hoisted(() => ({
  anthropicConstructor: vi.fn<(opts?: { maxRetries?: number }) => void>(),
}));

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const { default: AnthropicClient } = await importOriginal<{ default: typeof Anthropic }>();

  return {
    default: class extends AnthropicClient {
      constructor(opts: ConstructorParameters<typeof AnthropicClient>[0]) {
        super(opts);
        anthropicConstructor(opts);
      }
    },
  };
});

describe('Anthropic LLM prewarm', () => {
  it('lists one model with the prewarm cancellation signal', async () => {
    let prewarmSignal: AbortSignal | undefined;
    const modelsList = vi.fn(
      async (_params: { limit: number }, options: { signal?: AbortSignal }) => {
        prewarmSignal = options.signal;
      },
    );
    const client = {
      baseURL: 'https://api.anthropic.test',
      models: { list: modelsList },
    } as unknown as Anthropic;
    const llm = new LLM({ model: 'claude-sonnet-4-6', client });

    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(modelsList).toHaveBeenCalledWith({ limit: 1 }, { signal: expect.any(AbortSignal) });
    expect(prewarmSignal?.aborted).toBe(false);

    await llm.aclose();
    expect(prewarmSignal?.aborted).toBe(true);
  });
});

function messageStartEvent(): Anthropic.MessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_123',
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as Anthropic.MessageStreamEvent;
}

function textDeltaEvent(text: string): Anthropic.MessageStreamEvent {
  return {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text },
  } as Anthropic.MessageStreamEvent;
}

const getWeather = llm.tool({
  description: 'Look up the weather.',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => city,
});

const namedToolChoice: llm.ToolChoice = {
  type: 'function',
  function: { name: 'getWeather' },
};

async function toolChoice(
  model: string,
  choice: llm.ToolChoice,
  options: { parallelToolCalls?: boolean } = {},
): Promise<Anthropic.MessageCreateParamsStreaming['tool_choice']> {
  let capturedParams: Anthropic.MessageCreateParamsStreaming | undefined;
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsStreaming) => {
        capturedParams = params;
        return (async function* (): AsyncGenerator<Anthropic.MessageStreamEvent> {
          yield messageStartEvent();
        })();
      },
    },
  } as unknown as Anthropic;
  const anthropicLlm = new LLM({ apiKey: 'dummy', client, model, parallelToolCalls: undefined });
  const stream = anthropicLlm.chat({
    chatCtx: new llm.ChatContext(),
    toolCtx: { getWeather },
    toolChoice: choice,
    ...options,
  });
  for await (const _ of stream) {
    // drain
  }
  return capturedParams!.tool_choice;
}

async function collectTextFromEvents(
  events: Anthropic.MessageStreamEvent[],
  toolCtx?: llm.ToolContextLike,
): Promise<string> {
  const client = {
    messages: {
      create: async () =>
        (async function* (): AsyncGenerator<Anthropic.MessageStreamEvent> {
          yield* events;
        })(),
    },
  } as unknown as Anthropic;
  const anthropicLlm = new LLM({
    apiKey: 'dummy',
    client,
    model: 'claude-3-5-sonnet-20241022',
  });
  const chatCtx = new llm.ChatContext();
  chatCtx.addMessage({ role: 'user', content: 'Hello, world!' });

  const stream = anthropicLlm.chat({ chatCtx, toolCtx });
  const textChunks: string[] = [];
  for await (const chunk of stream) {
    if (chunk.delta?.content) {
      textChunks.push(chunk.delta.content);
    }
  }
  return textChunks.join('');
}

describe('Anthropic LLM', () => {
  it('sends forced tool choice as auto only for rejecting models', async () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-fable-5-1',
      'claude-mythos-5-1',
    ]) {
      expect(await toolChoice(model, 'required')).toEqual({ type: 'auto' });
      expect(await toolChoice(model, namedToolChoice)).toEqual({ type: 'auto' });
    }

    expect(await toolChoice('claude-sonnet-5-5', 'required', { parallelToolCalls: false })).toEqual(
      { type: 'auto', disable_parallel_tool_use: true },
    );

    for (const model of [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-haiku-5-5',
    ]) {
      expect(await toolChoice(model, 'required')).toEqual({ type: 'any' });
      expect(await toolChoice(model, namedToolChoice)).toEqual({
        type: 'tool',
        name: 'getWeather',
      });
    }
  });

  it('logs the forced tool choice warning once', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const requests: Anthropic.MessageCreateParamsStreaming[] = [];
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsStreaming) => {
          requests.push(params);
          return (async function* (): AsyncGenerator<Anthropic.MessageStreamEvent> {
            yield messageStartEvent();
          })();
        },
      },
    } as unknown as Anthropic;
    const anthropicLlm = new LLM({
      apiKey: 'dummy',
      client,
      model: 'claude-sonnet-5-5',
      parallelToolCalls: undefined,
      toolChoice: 'required',
    });

    for (let i = 0; i < 3; i++) {
      const stream = anthropicLlm.chat({
        chatCtx: new llm.ChatContext(),
        toolCtx: { getWeather },
      });
      for await (const _ of stream) {
        // drain
      }
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { model: 'claude-sonnet-5-5' },
      expect.stringContaining('forced tool_choice'),
    );
    expect(requests.map((request) => request.tool_choice)).toEqual([
      { type: 'auto' },
      { type: 'auto' },
      { type: 'auto' },
    ]);
  });

  it('disables Anthropic SDK retries by default', () => {
    const callCount = anthropicConstructor.mock.calls.length;

    new LLM({ apiKey: 'dummy', model: 'claude-3-5-sonnet-20241022' });

    expect(anthropicConstructor.mock.calls[callCount]?.[0]).toEqual(
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it('leaves an injected client and its retry policy untouched', () => {
    const client = {
      baseURL: 'https://api.anthropic.test',
      maxRetries: 7,
    } as unknown as Anthropic;
    const callCount = anthropicConstructor.mock.calls.length;

    const anthropicLlm = new LLM({ client, model: 'claude-3-5-sonnet-20241022' });

    // The caller owns the client: no SDK client is constructed on its behalf.
    expect(anthropicConstructor.mock.calls).toHaveLength(callCount);
    expect(anthropicLlm.provider).toBe('api.anthropic.test');
    expect(client.maxRetries).toBe(7);
  });

  it('forwards an explicit maxRetries to the Anthropic SDK', () => {
    const callCount = anthropicConstructor.mock.calls.length;

    new LLM({ apiKey: 'dummy', model: 'claude-3-5-sonnet-20241022', maxRetries: 2 });

    expect(anthropicConstructor.mock.calls[callCount]?.[0]).toEqual(
      expect.objectContaining({ maxRetries: 2 }),
    );
  });

  it('correctly maps ChatContext to Anthropic system and messages arrays', () => {
    const anthropicLlm = new LLM({ apiKey: 'dummy', model: 'claude-3-5-sonnet-20241022' });

    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({
      role: 'system',
      content: 'You are a mock agent.',
    });
    chatCtx.addMessage({
      role: 'user',
      content: 'Hello, world!',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { system, messages } = (anthropicLlm as any)._buildAnthropicContext(chatCtx);

    // Assert that system prompts were correctly isolated
    expect(system).toHaveLength(1);
    expect(system[0].text).toBe('You are a mock agent.');

    // Assert that strictly user messages ended up in the messages payload
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello, world!');
  });

  it('merges consecutive same-role messages', () => {
    const anthropicLlm = new LLM({ apiKey: 'dummy', model: 'claude-3-5-sonnet-20241022' });

    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'First message' });
    chatCtx.addMessage({ role: 'user', content: 'Second message' });
    chatCtx.addMessage({ role: 'assistant', content: 'Reply' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { messages } = (anthropicLlm as any)._buildAnthropicContext(chatCtx);

    // Two user messages should be merged into one with array content, followed by a
    // trailing dummy user turn for Claude 4.6+.
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toEqual([{ type: 'text', text: '.' }]);
  });

  it('injects a dummy user message if conversation starts with assistant', () => {
    const anthropicLlm = new LLM({ apiKey: 'dummy', model: 'claude-3-5-sonnet-20241022' });

    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'system', content: 'System prompt' });
    chatCtx.addMessage({ role: 'assistant', content: 'I start talking' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { messages } = (anthropicLlm as any)._buildAnthropicContext(chatCtx);

    // Should have injected a dummy user message at the start
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('(empty)');
    expect(messages[1].role).toBe('assistant');
  });

  it('handles function_call and function_call_output items', () => {
    const anthropicLlm = new LLM({ apiKey: 'dummy', model: 'claude-3-5-sonnet-20241022' });

    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'What is the weather?' });

    // Simulate a function call from the assistant
    chatCtx.items.push(
      new llm.FunctionCall({
        callId: 'call_123',
        name: 'get_weather',
        args: '{"city":"London"}',
      }),
    );

    // Simulate the tool result
    chatCtx.items.push(
      new llm.FunctionCallOutput({
        callId: 'call_123',
        name: 'get_weather',
        output: '{"temp": 20}',
        isError: false,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { messages } = (anthropicLlm as any)._buildAnthropicContext(chatCtx);

    // user message, then assistant tool_use, then user tool_result
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(Array.isArray(messages[1].content)).toBe(true);
    expect(messages[1].content[0].type).toBe('tool_use');
    expect(messages[1].content[0].id).toBe('call_123');
    expect(messages[2].role).toBe('user');
    expect(Array.isArray(messages[2].content)).toBe(true);
    expect(messages[2].content[0].type).toBe('tool_result');
  });

  it('drops a function_call whose output has not arrived yet', () => {
    const anthropicLlm = new LLM({ apiKey: 'dummy', model: 'claude-3-5-sonnet-20241022' });

    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Book me tomorrow at 10' });
    chatCtx.items.push(
      new llm.FunctionCall({
        callId: 'call_in_flight',
        name: 'check_availability',
        args: '{"day":"tomorrow"}',
      }),
    );
    chatCtx.addMessage({ role: 'user', content: 'Actually, make it 11' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { messages } = (anthropicLlm as any)._buildAnthropicContext(chatCtx);

    expect(JSON.stringify(messages)).not.toContain('tool_use');
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Book me tomorrow at 10' },
          { type: 'text', text: 'Actually, make it 11' },
        ],
      },
    ]);
  });

  it('drops a function_call_output whose call is not in the context', () => {
    const anthropicLlm = new LLM({ apiKey: 'dummy', model: 'claude-3-5-sonnet-20241022' });

    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hi' });
    chatCtx.items.push(
      new llm.FunctionCallOutput({
        callId: 'call_truncated',
        name: 'get_weather',
        output: '{"temp": 20}',
        isError: false,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { messages } = (anthropicLlm as any)._buildAnthropicContext(chatCtx);

    expect(JSON.stringify(messages)).not.toContain('tool_result');
  });

  it('puts tool_result blocks first when a user message lands before the output', () => {
    const anthropicLlm = new LLM({ apiKey: 'dummy', model: 'claude-3-5-sonnet-20241022' });

    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'What is the weather?' });
    chatCtx.items.push(new llm.FunctionCall({ callId: 'call_1', name: 'get_weather', args: '{}' }));
    chatCtx.addMessage({ role: 'user', content: 'In London' });
    chatCtx.items.push(
      new llm.FunctionCallOutput({
        callId: 'call_1',
        name: 'get_weather',
        output: '{"temp": 20}',
        isError: false,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { messages } = (anthropicLlm as any)._buildAnthropicContext(chatCtx);

    expect(messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'call_1' });
    expect(messages[2].role).toBe('user');
    expect(messages[2].content.map((block: { type: string }) => block.type)).toEqual([
      'tool_result',
      'text',
    ]);
  });

  it('creates a fresh stream on retry', async () => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error('transient connect failure');
          }
          return (async function* (): AsyncGenerator<Anthropic.MessageStreamEvent> {})();
        },
      },
    } as unknown as Anthropic;
    const anthropicLlm = new LLM({
      apiKey: 'dummy',
      client,
      model: 'claude-3-5-sonnet-20241022',
    });
    anthropicLlm.on('error', () => {});
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hello, world!' });

    const stream = anthropicLlm.chat({
      chatCtx,
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    const chunks: llm.ChatChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(calls).toBe(2);
    expect(chunks.at(-1)?.usage).toEqual({
      completionTokens: 0,
      promptTokens: 0,
      promptCachedTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
    });
  });

  it('sends function tool schemas from a real ToolContext', async () => {
    let capturedParams: Anthropic.MessageCreateParamsStreaming | undefined;
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParamsStreaming) => {
          capturedParams = params;
          return (async function* (): AsyncGenerator<Anthropic.MessageStreamEvent> {
            yield messageStartEvent();
          })();
        },
      },
    } as unknown as Anthropic;
    const anthropicLlm = new LLM({
      apiKey: 'dummy',
      client,
      model: 'claude-3-5-sonnet-20241022',
    });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'What is the weather in Tokyo?' });

    const toolCtx = llm.toToolContext({
      getWeather: llm.tool({
        description: 'Get the weather for a given location.',
        parameters: z.object({ location: z.string() }),
        execute: async () => 'sunny',
      }),
    });

    const stream = anthropicLlm.chat({ chatCtx, toolCtx });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of stream) {
      // drain
    }

    expect(capturedParams?.tools).toHaveLength(1);
    const toolSchema = capturedParams!.tools![0] as Anthropic.Tool;
    expect(toolSchema.name).toBe('getWeather');
    expect(toolSchema.description).toBe('Get the weather for a given location.');
    expect(toolSchema.input_schema.type).toBe('object');
    expect(Object.keys(toolSchema.input_schema.properties ?? {})).toEqual(['location']);
  });

  it('does not emit an empty delta for a fully-filtered thinking block', async () => {
    const client = {
      messages: {
        create: async () =>
          (async function* (): AsyncGenerator<Anthropic.MessageStreamEvent> {
            yield messageStartEvent();
            yield textDeltaEvent('<thinking>only reasoning</thinking>');
          })(),
      },
    } as unknown as Anthropic;
    const anthropicLlm = new LLM({
      apiKey: 'dummy',
      client,
      model: 'claude-3-5-sonnet-20241022',
    });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hello, world!' });

    const stream = anthropicLlm.chat({ chatCtx, toolCtx: llm.ToolContext.empty() });
    const contentChunks: string[] = [];
    for await (const chunk of stream) {
      if (chunk.delta?.content !== undefined) {
        contentChunks.push(chunk.delta.content);
      }
    }

    // The whole delta was a thinking block: nothing (not even '') is emitted.
    expect(contentChunks).toEqual([]);
  });

  it('filters thinking blocks when tools are active', async () => {
    const text = await collectTextFromEvents(
      [
        messageStartEvent(),
        textDeltaEvent('<thinking>hidden'),
        textDeltaEvent('still hidden</thinking>visible'),
      ],
      llm.ToolContext.empty(),
    );

    expect(text).toBe('visible');
  });

  it('does not filter thinking blocks without tools', async () => {
    const text = await collectTextFromEvents([
      messageStartEvent(),
      textDeltaEvent('<thinking>visible without tools</thinking>'),
    ]);

    expect(text).toBe('<thinking>visible without tools</thinking>');
  });

  it('preserves text around same-delta thinking blocks', async () => {
    const text = await collectTextFromEvents(
      [messageStartEvent(), textDeltaEvent('before <thinking>hidden</thinking> after')],
      llm.ToolContext.empty(),
    );

    expect(text).toBe('before  after');
  });

  it('preserves text before split thinking blocks', async () => {
    const text = await collectTextFromEvents(
      [
        messageStartEvent(),
        textDeltaEvent('before <thinking>hidden'),
        textDeltaEvent('still hidden</thinking> after'),
      ],
      llm.ToolContext.empty(),
    );

    expect(text).toBe('before  after');
  });
});
