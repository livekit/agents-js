// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../../log.js';
import {
  AgentHandoffItem,
  ChatContext,
  FunctionCall,
  FunctionCallOutput,
  Instructions,
} from '../chat_context.js';
import { serializeImage } from '../utils.js';
import { toChatCtx } from './aws.js';

vi.mock('../utils.js', () => ({
  serializeImage: vi.fn(),
}));

describe('AWS Provider Format - toChatCtx', () => {
  const serializeImageMock = vi.mocked(serializeImage);

  initializeLogger({ level: 'silent', pretty: false });

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('should convert simple text messages', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'Hello' });
    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });

    const [result, formatData] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      { role: 'user', content: [{ text: 'Hello' }] },
      { role: 'assistant', content: [{ text: 'Hi there!' }] },
    ]);
    expect(formatData.systemMessages).toBeNull();
  });

  it('should extract system messages separately', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are a helpful assistant' });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const [result, formatData] = await toChatCtx(ctx, false);

    expect(result).toEqual([{ role: 'user', content: [{ text: 'Hello' }] }]);
    expect(formatData.systemMessages).toEqual(['You are a helpful assistant']);
  });

  it('should extract developer messages as system messages', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'developer', content: 'Be concise' });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const [result, formatData] = await toChatCtx(ctx, false);

    expect(result).toEqual([{ role: 'user', content: [{ text: 'Hello' }] }]);
    expect(formatData.systemMessages).toEqual(['Be concise']);
  });

  it('should drop a system message with no text content instead of reattributing it to user', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'auto',
      mimeType: 'image/png',
      base64Data: 'aW1n',
    });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'system',
      content: [
        {
          id: 'img1',
          type: 'image_content',
          image: 'data:image/png;base64,aW1n',
          inferenceDetail: 'auto',
          _cache: {},
        },
      ],
    });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const [result, formatData] = await toChatCtx(ctx, false);

    // The image-only system message must not surface as a 'user' turn.
    expect(result).toEqual([{ role: 'user', content: [{ text: 'Hello' }] }]);
    expect(formatData.systemMessages).toBeNull();
  });

  it('should drop empty and whitespace-only text blocks', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: '   ' });
    ctx.addMessage({ role: 'user', content: '' });
    ctx.addMessage({
      role: 'user',
      content: [
        '   ',
        new Instructions({ audio: 'audio instructions', text: '   ' }).asModality('text'),
      ],
    });

    const [result, formatData] = await toChatCtx(ctx, false);

    expect(result).toEqual([]);
    expect(formatData.systemMessages).toBeNull();
  });

  it('should replace blank tool output with non-empty placeholder text', async () => {
    const ctx = ChatContext.empty();
    ctx.insert(
      new FunctionCall({
        id: 'func_blank_output',
        callId: 'call_blank_output',
        name: 'blank_output',
        args: '{}',
      }),
    );
    ctx.insert(
      new FunctionCallOutput({
        callId: 'call_blank_output',
        output: '   ',
        isError: false,
      }),
    );

    const [result] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 'call_blank_output',
              name: 'blank_output',
              input: {},
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'call_blank_output',
              content: [{ text: '(empty)' }],
              status: 'success',
            },
          },
        ],
      },
    ]);
  });

  it('should render Instructions as their resolved value', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'system',
      content: [
        new Instructions({ audio: 'audio instructions', text: 'text instructions' }).asModality(
          'text',
        ),
      ],
    });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const [, formatData] = await toChatCtx(ctx, false);

    expect(formatData.systemMessages).toEqual(['text instructions']);
  });

  it('should concatenate multiple system messages as separate entries', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are a helpful assistant' });
    ctx.addMessage({ role: 'system', content: 'Be concise in your responses' });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const [result, formatData] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            text: 'New instructions received. Apply them carefully: Be concise in your responses',
          },
          { text: 'Hello' },
        ],
      },
    ]);
    expect(formatData.systemMessages).toEqual(['You are a helpful assistant']);
  });

  it('should merge consecutive messages with the same effective role', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'First user message' });
    ctx.addMessage({ role: 'user', content: 'Second user message' });
    ctx.addMessage({ role: 'assistant', content: 'First assistant response' });
    ctx.addMessage({ role: 'assistant', content: 'Second assistant response' });

    const [result, formatData] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      {
        role: 'user',
        content: [{ text: 'First user message' }, { text: 'Second user message' }],
      },
      {
        role: 'assistant',
        content: [{ text: 'First assistant response' }, { text: 'Second assistant response' }],
      },
    ]);
    expect(formatData.systemMessages).toBeNull();
  });

  it('should map function calls to assistant toolUse blocks and outputs to user toolResult blocks', async () => {
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
      name: 'get_weather',
      output: '{"temperature": 72, "condition": "sunny"}',
      isError: false,
    });

    ctx.insert([toolCall, toolOutput]);

    const [result, formatData] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      {
        role: 'assistant',
        content: [
          { text: 'Let me check.' },
          {
            toolUse: {
              toolUseId: 'call_123',
              name: 'get_weather',
              input: { location: 'San Francisco' },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'call_123',
              content: [{ text: '{"temperature": 72, "condition": "sunny"}' }],
              status: 'success',
            },
          },
        ],
      },
    ]);
    expect(formatData.systemMessages).toBeNull();
  });

  it('should map a failed tool call output to status "error"', async () => {
    const ctx = ChatContext.empty();

    const toolCall = new FunctionCall({
      id: 'func_error',
      callId: 'call_error',
      name: 'failing_function',
      args: '{}',
    });
    const toolOutput = new FunctionCallOutput({
      callId: 'call_error',
      name: 'failing_function',
      output: 'Function failed to execute',
      isError: true,
    });

    ctx.insert([toolCall, toolOutput]);

    const [result] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 'call_error',
              name: 'failing_function',
              input: {},
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'call_error',
              content: [{ text: 'Function failed to execute' }],
              status: 'error',
            },
          },
        ],
      },
    ]);
  });

  it('should inject a dummy user message when the conversation does not start with user', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });

    const [result, formatData] = await toChatCtx(ctx, true);

    expect(result).toEqual([
      { role: 'user', content: [{ text: '(empty)' }] },
      { role: 'assistant', content: [{ text: 'Hi there!' }] },
      { role: 'user', content: [{ text: '.' }] },
    ]);
    expect(formatData.systemMessages).toBeNull();
  });

  it('should not inject a leading dummy user message when the conversation already starts with user', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'Hello' });
    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });

    const [result] = await toChatCtx(ctx, true);

    // Still gets a trailing dummy user turn since it ends on 'assistant'.
    expect(result).toEqual([
      { role: 'user', content: [{ text: 'Hello' }] },
      { role: 'assistant', content: [{ text: 'Hi there!' }] },
      { role: 'user', content: [{ text: '.' }] },
    ]);
  });

  it('should not inject a trailing dummy user message when the conversation already ends on user', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'Hello' });
    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });
    ctx.addMessage({ role: 'user', content: 'Follow-up' });

    const [result] = await toChatCtx(ctx, true);

    expect(result).toEqual([
      { role: 'user', content: [{ text: 'Hello' }] },
      { role: 'assistant', content: [{ text: 'Hi there!' }] },
      { role: 'user', content: [{ text: 'Follow-up' }] },
    ]);
  });

  it('should not inject a trailing dummy user message when disabled', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'Hello' });
    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });

    const [result] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      { role: 'user', content: [{ text: 'Hello' }] },
      { role: 'assistant', content: [{ text: 'Hi there!' }] },
    ]);
  });

  it('should not inject a dummy user message when disabled', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are helpful' });

    const [result, formatData] = await toChatCtx(ctx, false);

    expect(result).toEqual([]);
    expect(formatData.systemMessages).toEqual(['You are helpful']);
  });

  it('should inject a dummy user message for an entirely empty conversation', async () => {
    const ctx = ChatContext.empty();

    const [result] = await toChatCtx(ctx, true);

    expect(result).toEqual([{ role: 'user', content: [{ text: '(empty)' }] }]);
  });

  it('should convert supported inline images to Bedrock image blocks', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'auto',
      mimeType: 'image/png',
      base64Data: Buffer.from('fake-png-bytes').toString('base64'),
    });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        'Look at this:',
        {
          id: 'img1',
          type: 'image_content',
          image: 'data:image/png;base64,ZmFrZS1wbmctYnl0ZXM=',
          inferenceDetail: 'auto',
          _cache: {},
        },
      ],
    });

    const [result] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { text: 'Look at this:' },
          {
            image: {
              format: 'png',
              source: { bytes: Buffer.from('fake-png-bytes') },
            },
          },
        ],
      },
    ]);
  });

  it('should default to jpeg format when mimeType is missing', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'auto',
      base64Data: Buffer.from('raw-bytes').toString('base64'),
    });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        {
          id: 'img1',
          type: 'image_content',
          image: 'data:image/jpeg;base64,cmF3LWJ5dGVz',
          inferenceDetail: 'auto',
          _cache: {},
        },
      ],
    });

    const [result] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            image: {
              format: 'jpeg',
              source: { bytes: Buffer.from('raw-bytes') },
            },
          },
        ],
      },
    ]);
  });

  it('should throw for unsupported image mime types', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'auto',
      mimeType: 'image/bmp',
      base64Data: Buffer.from('bmp-bytes').toString('base64'),
    });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        {
          id: 'img1',
          type: 'image_content',
          image: 'data:image/bmp;base64,Ym1wLWJ5dGVz',
          inferenceDetail: 'auto',
          _cache: {},
        },
      ],
    });

    await expect(toChatCtx(ctx, false)).rejects.toThrow(/Unsupported mimeType/);
  });

  it('should throw for externalUrl images', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'high',
      externalUrl: 'https://example.com/image.jpg',
      mimeType: 'image/jpeg',
    });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        {
          id: 'img1',
          type: 'image_content',
          image: 'https://example.com/image.jpg',
          inferenceDetail: 'high',
          _cache: {},
        },
      ],
    });

    await expect(toChatCtx(ctx, false)).rejects.toThrow(/externalUrl images are not supported/);
  });

  it('should filter out agent handoff items', async () => {
    const ctx = ChatContext.empty();

    ctx.addMessage({ role: 'user', content: 'Hello' });
    ctx.insert(new AgentHandoffItem({ oldAgentId: 'agent_1', newAgentId: 'agent_2' }));
    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });

    const [result] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      { role: 'user', content: [{ text: 'Hello' }] },
      { role: 'assistant', content: [{ text: 'Hi there!' }] },
    ]);
  });

  it('should filter out standalone function calls without outputs', async () => {
    const ctx = ChatContext.empty();

    const funcCall = new FunctionCall({
      id: 'func_standalone',
      callId: 'call_999',
      name: 'standalone_function',
      args: '{}',
    });

    ctx.insert(funcCall);

    const [result] = await toChatCtx(ctx, false);

    expect(result).toEqual([]);
  });

  it('should skip empty groups', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'Hello', createdAt: 1000 });

    const orphanOutput = new FunctionCallOutput({
      callId: 'orphan_call',
      output: 'This should be ignored',
      isError: false,
      createdAt: 2000,
    });
    ctx.insert(orphanOutput);

    ctx.addMessage({ role: 'assistant', content: 'Hi!', createdAt: 3000 });

    const [result] = await toChatCtx(ctx, false);

    expect(result).toEqual([
      { role: 'user', content: [{ text: 'Hello' }] },
      { role: 'assistant', content: [{ text: 'Hi!' }] },
    ]);
  });
});
