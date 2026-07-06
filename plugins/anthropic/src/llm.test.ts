// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type Anthropic from '@anthropic-ai/sdk';
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LLM } from './llm.js';

function llm.ToolContext.empty(): llm.ToolContext {
  return llm.toToolContext([]);
}

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
