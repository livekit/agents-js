// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import {
  AgentHandoffItem,
  ChatContext,
  FunctionCall,
  FunctionCallOutput,
} from '../chat_context.js';
import { toChatCtx } from './mistralai.js';

describe('Mistral Provider Format - toChatCtx', () => {
  initializeLogger({ level: 'silent', pretty: false });

  it('should convert simple text messages', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'Hello' });
    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });

    const [entries, formatData] = toChatCtx(ctx);

    expect(entries).toEqual([
      { type: 'message.input', role: 'user', content: 'Hello' },
      { type: 'message.output', role: 'assistant', content: 'Hi there!' },
    ]);
    expect(formatData.instructions).toBe('');
  });

  it('should extract system messages as instructions', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are a helpful assistant' });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const [entries, formatData] = toChatCtx(ctx);

    expect(entries).toEqual([{ type: 'message.input', role: 'user', content: 'Hello' }]);
    expect(formatData.instructions).toBe('You are a helpful assistant');
  });

  it('should extract developer messages as instructions', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'developer', content: 'Be concise' });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const [entries, formatData] = toChatCtx(ctx);

    expect(entries).toEqual([{ type: 'message.input', role: 'user', content: 'Hello' }]);
    expect(formatData.instructions).toBe('Be concise');
  });

  it('should concatenate multiple system messages', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are a helpful assistant' });
    ctx.addMessage({ role: 'system', content: 'Be concise in your responses' });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const [entries, formatData] = toChatCtx(ctx);

    expect(entries).toEqual([{ type: 'message.input', role: 'user', content: 'Hello' }]);
    expect(formatData.instructions).toBe('You are a helpful assistant\nBe concise in your responses');
  });

  it('should handle multi-line text content', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: ['Line 1', 'Line 2', 'Line 3'] });

    const [entries] = toChatCtx(ctx);

    expect(entries).toEqual([
      { type: 'message.input', role: 'user', content: 'Line 1\nLine 2\nLine 3' },
    ]);
  });

  it('should handle tool calls as function.call entries', () => {
    const ctx = ChatContext.empty();

    const msg = ctx.addMessage({ role: 'assistant', content: 'Let me check.' });
    const toolCall = FunctionCall.create({
      id: msg.id + '/tool_1',
      callId: 'call_123',
      name: 'get_weather',
      args: '{"location": "San Francisco"}',
    });
    const toolOutput = FunctionCallOutput.create({
      callId: 'call_123',
      output: '{"temperature": 72, "condition": "sunny"}',
      isError: false,
    });

    ctx.insert([toolCall, toolOutput]);

    const [entries] = toChatCtx(ctx);

    expect(entries).toEqual([
      { type: 'message.output', role: 'assistant', content: 'Let me check.' },
      {
        type: 'function.call',
        toolCallId: 'call_123',
        name: 'get_weather',
        arguments: '{"location": "San Francisco"}',
      },
      {
        type: 'function.result',
        toolCallId: 'call_123',
        result: '{"temperature": 72, "condition": "sunny"}',
      },
    ]);
  });

  it('should handle multiple tool calls', () => {
    const ctx = ChatContext.empty();

    const msg = ctx.addMessage({ role: 'assistant', content: "I'll check both." });
    const toolCall1 = new FunctionCall({
      id: msg.id + '/tool_1',
      callId: 'call_1',
      name: 'get_weather',
      args: '{"location": "NYC"}',
    });
    const toolCall2 = new FunctionCall({
      id: msg.id + '/tool_2',
      callId: 'call_2',
      name: 'get_weather',
      args: '{"location": "LA"}',
    });
    const toolOutput1 = new FunctionCallOutput({
      callId: 'call_1',
      output: '{"temperature": 65}',
      isError: false,
    });
    const toolOutput2 = new FunctionCallOutput({
      callId: 'call_2',
      output: '{"temperature": 78}',
      isError: false,
    });

    ctx.insert([toolCall1, toolCall2, toolOutput1, toolOutput2]);

    const [entries] = toChatCtx(ctx);

    expect(entries).toEqual([
      { type: 'message.output', role: 'assistant', content: "I'll check both." },
      {
        type: 'function.call',
        toolCallId: 'call_1',
        name: 'get_weather',
        arguments: '{"location": "NYC"}',
      },
      {
        type: 'function.call',
        toolCallId: 'call_2',
        name: 'get_weather',
        arguments: '{"location": "LA"}',
      },
      {
        type: 'function.result',
        toolCallId: 'call_1',
        result: '{"temperature": 65}',
      },
      {
        type: 'function.result',
        toolCallId: 'call_2',
        result: '{"temperature": 78}',
      },
    ]);
  });

  it('should handle tool calls without accompanying message', () => {
    const ctx = ChatContext.empty();

    const toolCall = new FunctionCall({
      id: 'func_123',
      callId: 'call_456',
      name: 'calculate',
      args: '{"a": 5, "b": 3}',
    });
    const toolOutput = new FunctionCallOutput({
      callId: 'call_456',
      output: '{"result": 8}',
      isError: false,
    });

    ctx.insert([toolCall, toolOutput]);

    const [entries] = toChatCtx(ctx);

    expect(entries).toEqual([
      {
        type: 'function.call',
        toolCallId: 'call_456',
        name: 'calculate',
        arguments: '{"a": 5, "b": 3}',
      },
      {
        type: 'function.result',
        toolCallId: 'call_456',
        result: '{"result": 8}',
      },
    ]);
  });

  it('should inject dummy user message when entries are empty', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are helpful' });

    const [entries, formatData] = toChatCtx(ctx, true);

    expect(entries).toEqual([{ type: 'message.input', role: 'user', content: '.' }]);
    expect(formatData.instructions).toBe('You are helpful');
  });

  it('should not inject dummy user message when disabled', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are helpful' });

    const [entries, formatData] = toChatCtx(ctx, false);

    expect(entries).toEqual([]);
    expect(formatData.instructions).toBe('You are helpful');
  });

  it('should not inject dummy user message when entries exist', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are helpful' });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const [entries] = toChatCtx(ctx, true);

    expect(entries).toEqual([{ type: 'message.input', role: 'user', content: 'Hello' }]);
  });

  it('should handle empty chat context', () => {
    const ctx = ChatContext.empty();

    const [entries, formatData] = toChatCtx(ctx, true);

    expect(entries).toEqual([{ type: 'message.input', role: 'user', content: '.' }]);
    expect(formatData.instructions).toBe('');
  });

  it('should handle empty chat context without dummy injection', () => {
    const ctx = ChatContext.empty();

    const [entries, formatData] = toChatCtx(ctx, false);

    expect(entries).toEqual([]);
    expect(formatData.instructions).toBe('');
  });

  it('should filter non-string content from messages', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        'Hello',
        {
          id: 'img1',
          type: 'image_content',
          image: 'https://example.com/image.jpg',
          inferenceDetail: 'high',
          _cache: {},
        },
        'World',
      ],
    });

    const [entries] = toChatCtx(ctx);

    // Non-string content is filtered out, text parts are joined
    expect(entries).toEqual([
      { type: 'message.input', role: 'user', content: 'Hello\nWorld' },
    ]);
  });

  it('should skip agent handoff items', () => {
    const ctx = ChatContext.empty();

    ctx.addMessage({ role: 'user', content: 'Hello' });
    ctx.insert(new AgentHandoffItem({ oldAgentId: 'agent_1', newAgentId: 'agent_2' }));
    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });

    const [entries] = toChatCtx(ctx);

    expect(entries).toEqual([
      { type: 'message.input', role: 'user', content: 'Hello' },
      { type: 'message.output', role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('should handle a full conversation with tools and system messages', () => {
    const ctx = ChatContext.empty();

    ctx.addMessage({ role: 'system', content: 'You are a weather assistant' });
    ctx.addMessage({ role: 'user', content: 'What is the weather in Paris?' });
    const assistantMsg = ctx.addMessage({ role: 'assistant', content: 'Let me check.' });

    const toolCall = FunctionCall.create({
      id: assistantMsg.id + '/tool_1',
      callId: 'call_weather',
      name: 'get_weather',
      args: '{"city": "Paris"}',
    });
    const toolOutput = FunctionCallOutput.create({
      callId: 'call_weather',
      output: 'Sunny, 22C',
      isError: false,
    });
    ctx.insert([toolCall, toolOutput]);

    ctx.addMessage({ role: 'assistant', content: 'It is sunny and 22C in Paris.' });

    const [entries, formatData] = toChatCtx(ctx);

    expect(formatData.instructions).toBe('You are a weather assistant');
    expect(entries).toEqual([
      { type: 'message.input', role: 'user', content: 'What is the weather in Paris?' },
      { type: 'message.output', role: 'assistant', content: 'Let me check.' },
      {
        type: 'function.call',
        toolCallId: 'call_weather',
        name: 'get_weather',
        arguments: '{"city": "Paris"}',
      },
      {
        type: 'function.result',
        toolCallId: 'call_weather',
        result: 'Sunny, 22C',
      },
      { type: 'message.output', role: 'assistant', content: 'It is sunny and 22C in Paris.' },
    ]);
  });
});
