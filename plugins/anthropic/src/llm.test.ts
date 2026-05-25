// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { LLM } from './llm.js';

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

    // Two user messages should be merged into one with array content
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
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
});
