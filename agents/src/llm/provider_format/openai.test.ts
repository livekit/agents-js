// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../../log.js';
import {
  AgentHandoffItem,
  ChatContext,
  FunctionCall,
  FunctionCallOutput,
} from '../chat_context.js';
import { serializeImage } from '../utils.js';
import { toChatCtx } from './openai.js';

// Mock the serializeImage function
vi.mock('../utils.js', () => ({
  serializeImage: vi.fn(),
}));

describe('toChatCtx', () => {
  const serializeImageMock = vi.mocked(serializeImage);

  // initialize logger at start of test
  initializeLogger({ level: 'silent', pretty: false });

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('should convert simple text messages', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'Hello' });
    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });

    const result = await toChatCtx(ctx);

    // Messages should be in the result, order may vary due to ID-based sorting
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
  });

  it('should handle system messages', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are a helpful assistant' });
    ctx.addMessage({ role: 'user', content: 'Hello' });

    const result = await toChatCtx(ctx);

    // Messages should be in the result, order may vary due to ID-based sorting
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' });
    expect(result[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should handle multi-line text content', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: ['Line 1', 'Line 2', 'Line 3'] });

    const result = await toChatCtx(ctx);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'Line 1\nLine 2\nLine 3' });
  });

  it('should handle messages with external URL images', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'high',
      externalUrl: 'https://example.com/image.jpg',
    });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        'Check out this image:',
        {
          id: 'img1',
          type: 'image_content',
          image: 'https://example.com/image.jpg',
          inferenceDetail: 'high',
          _cache: {},
        },
      ],
    });

    const result = await toChatCtx(ctx);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'https://example.com/image.jpg',
              detail: 'high',
            },
          },
          { type: 'text', text: 'Check out this image:' },
        ],
      },
    ]);
  });

  it('should handle messages with base64 images', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'auto',
      mimeType: 'image/png',
      base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'assistant',
      content: [
        {
          id: 'img1',
          type: 'image_content',
          image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          inferenceDetail: 'auto',
          _cache: {},
        },
        'Here is the image you requested',
      ],
    });

    const result = await toChatCtx(ctx);

    expect(result).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
              detail: 'auto',
            },
          },
          { type: 'text', text: 'Here is the image you requested' },
        ],
      },
    ]);
  });

  it('should handle VideoFrame images', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'low',
      mimeType: 'image/jpeg',
      base64Data: '/9j/4AAQSkZJRg==',
    });

    const frameData = new Uint8Array(4 * 4 * 4); // 4x4 RGBA
    const videoFrame = new VideoFrame(frameData, 4, 4, VideoBufferType.RGBA);

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        {
          id: 'frame1',
          type: 'image_content',
          image: videoFrame,
          inferenceDetail: 'low',
          _cache: {},
        },
      ],
    });

    const result = await toChatCtx(ctx);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
              detail: 'low',
            },
          },
        ],
      },
    ]);
  });

  it('should cache serialized images', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'high',
      mimeType: 'image/png',
      base64Data: 'cached-data',
    });

    const imageContent = {
      id: 'img1',
      type: 'image_content' as const,
      image: 'https://example.com/image.jpg',
      inferenceDetail: 'high' as const,
      _cache: {},
    };

    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: [imageContent] });

    // Call twice to test caching
    await toChatCtx(ctx);
    await toChatCtx(ctx);

    // serializeImage should only be called once due to caching
    expect(serializeImageMock).toHaveBeenCalledTimes(1);
    expect(imageContent._cache).toHaveProperty('serialized_image');
  });

  it('should handle tool calls and outputs', async () => {
    const ctx = ChatContext.empty();

    // Add an assistant message with tool calls
    const msg = ctx.addMessage({ role: 'assistant', content: 'Let me help you with that.' });
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

    const result = await toChatCtx(ctx);

    expect(result).toEqual([
      {
        role: 'assistant',
        content: 'Let me help you with that.',
        tool_calls: [
          {
            type: 'function',
            id: 'call_123',
            function: {
              name: 'get_weather',
              arguments: '{"location": "San Francisco"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_123',
        content: '{"temperature": 72, "condition": "sunny"}',
      },
    ]);
  });

  it('should handle multiple tool calls in one message', async () => {
    const ctx = ChatContext.empty();

    const msg = ctx.addMessage({ role: 'assistant', content: "I'll check both locations." });
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

    const result = await toChatCtx(ctx);

    expect(result).toEqual([
      {
        role: 'assistant',
        content: "I'll check both locations.",
        tool_calls: [
          {
            type: 'function',
            id: 'call_1',
            function: { name: 'get_weather', arguments: '{"location": "NYC"}' },
          },
          {
            type: 'function',
            id: 'call_2',
            function: { name: 'get_weather', arguments: '{"location": "LA"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"temperature": 65}',
      },
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: '{"temperature": 78}',
      },
    ]);
  });

  it('should handle tool calls without accompanying message', async () => {
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

    const result = await toChatCtx(ctx);

    expect(result).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'call_456',
            function: { name: 'calculate', arguments: '{"a": 5, "b": 3}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_456',
        content: '{"result": 8}',
      },
    ]);
  });

  it('should skip empty groups', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'Hello', createdAt: 1000 });

    // Create an isolated tool output without corresponding call (will be filtered)
    const orphanOutput = new FunctionCallOutput({
      callId: 'orphan_call',
      output: 'This should be ignored',
      isError: false,
      createdAt: 2000,
    });
    ctx.insert(orphanOutput);

    ctx.addMessage({ role: 'assistant', content: 'Hi!', createdAt: 3000 });

    const result = await toChatCtx(ctx);

    // Messages should be in the result, orphan output should be filtered out
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ role: 'user', content: 'Hello' });
    expect(result).toContainEqual({ role: 'assistant', content: 'Hi!' });
  });

  it('should handle mixed content with text and multiple images', async () => {
    serializeImageMock
      .mockResolvedValueOnce({
        inferenceDetail: 'high',
        externalUrl: 'https://example.com/image1.jpg',
      })
      .mockResolvedValueOnce({
        inferenceDetail: 'low',
        mimeType: 'image/png',
        base64Data: 'base64data',
      });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        'Here are two images:',
        {
          id: 'img1',
          type: 'image_content',
          image: 'https://example.com/image1.jpg',
          inferenceDetail: 'high',
          _cache: {},
        },
        'And the second one:',
        {
          id: 'img2',
          type: 'image_content',
          image: 'data:image/png;base64,base64data',
          inferenceDetail: 'low',
          _cache: {},
        },
        'What do you think?',
      ],
    });

    const result = await toChatCtx(ctx);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'https://example.com/image1.jpg',
              detail: 'high',
            },
          },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,base64data',
              detail: 'low',
            },
          },
          {
            type: 'text',
            text: 'Here are two images:\nAnd the second one:\nWhat do you think?',
          },
        ],
      },
    ]);
  });

  it('should handle content with only images and no text', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'auto',
      externalUrl: 'https://example.com/image.jpg',
    });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        {
          id: 'img1',
          type: 'image_content',
          image: 'https://example.com/image.jpg',
          inferenceDetail: 'auto',
          _cache: {},
        },
      ],
    });

    const result = await toChatCtx(ctx);

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'https://example.com/image.jpg',
              detail: 'auto',
            },
          },
        ],
      },
    ]);
  });

  it('should throw error for unsupported content type', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        {
          type: 'audio_content',
          frame: [],
        },
      ],
    });

    await expect(toChatCtx(ctx)).rejects.toThrow('Unsupported content type: audio_content');
  });

  it('should throw error when serialized image has no data', async () => {
    serializeImageMock.mockResolvedValue({
      inferenceDetail: 'high',
      // No base64Data or externalUrl
    });

    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        {
          id: 'img1',
          type: 'image_content',
          image: 'invalid-image',
          inferenceDetail: 'high',
          _cache: {},
        },
      ],
    });

    await expect(toChatCtx(ctx)).rejects.toThrow('Serialized image has no data bytes');
  });

  it('should filter out standalone function calls without outputs', async () => {
    const ctx = ChatContext.empty();

    // Add standalone function call without output
    const funcCall = new FunctionCall({
      id: 'func_standalone',
      callId: 'call_999',
      name: 'standalone_function',
      args: '{}',
    });

    ctx.insert(funcCall);

    const result = await toChatCtx(ctx);

    // Standalone function calls without outputs are filtered out by groupToolCalls
    expect(result).toEqual([]);
  });

  it('should handle function call output correctly', async () => {
    const ctx = ChatContext.empty();

    // First add a function call
    const funcCall = new FunctionCall({
      id: 'func_1',
      callId: 'call_output_test',
      name: 'test_function',
      args: '{}',
    });

    // Then add its output
    const funcOutput = new FunctionCallOutput({
      callId: 'call_output_test',
      output: 'Function executed successfully',
      isError: false,
    });

    ctx.insert([funcCall, funcOutput]);

    const result = await toChatCtx(ctx);

    expect(result).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_output_test',
            type: 'function',
            function: {
              name: 'test_function',
              arguments: '{}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_output_test',
        content: 'Function executed successfully',
      },
    ]);
  });

  it('should filter out agent handoff items', async () => {
    const ctx = ChatContext.empty();

    ctx.addMessage({ role: 'user', content: 'Hello' });

    // Insert an agent handoff item
    const handoff = new AgentHandoffItem({
      oldAgentId: 'agent_1',
      newAgentId: 'agent_2',
    });
    ctx.insert(handoff);

    ctx.addMessage({ role: 'assistant', content: 'Hi there!' });

    const result = await toChatCtx(ctx);

    // Agent handoff should be filtered out, only messages should remain
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('should handle multiple agent handoffs without errors', async () => {
    const ctx = ChatContext.empty();

    ctx.addMessage({ role: 'user', content: 'Start' });

    // Multiple handoffs
    ctx.insert(new AgentHandoffItem({ oldAgentId: undefined, newAgentId: 'agent_1' }));
    ctx.addMessage({ role: 'assistant', content: 'Response from agent 1' });

    ctx.insert(new AgentHandoffItem({ oldAgentId: 'agent_1', newAgentId: 'agent_2' }));
    ctx.addMessage({ role: 'assistant', content: 'Response from agent 2' });

    ctx.insert(new AgentHandoffItem({ oldAgentId: 'agent_2', newAgentId: 'agent_3' }));
    ctx.addMessage({ role: 'assistant', content: 'Response from agent 3' });

    const result = await toChatCtx(ctx);

    // All handoffs should be filtered out
    expect(result).toEqual([
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'Response from agent 1' },
      { role: 'assistant', content: 'Response from agent 2' },
      { role: 'assistant', content: 'Response from agent 3' },
    ]);
  });
});
