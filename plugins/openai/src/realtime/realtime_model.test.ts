// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import type * as api_proto from './api_proto.js';
import { livekitItemToOpenAIItem } from './realtime_model.js';

describe('livekitItemToOpenAIItem', () => {
  describe('message items', () => {
    it('should use output_text type for assistant messages', () => {
      const assistantMessage = new llm.ChatMessage({
        role: 'assistant',
        content: 'Hello, how can I help you?',
        id: 'test-assistant-msg',
      });

      const result = livekitItemToOpenAIItem(assistantMessage) as api_proto.AssistantItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('assistant');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('output_text');
      expect((content as api_proto.OutputTextContent).text).toBe('Hello, how can I help you?');
    });

    it('should use input_text type for user messages', () => {
      const userMessage = new llm.ChatMessage({
        role: 'user',
        content: 'What is the weather like?',
        id: 'test-user-msg',
      });

      const result = livekitItemToOpenAIItem(userMessage) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('user');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('input_text');
      expect((content as api_proto.InputTextContent).text).toBe('What is the weather like?');
    });

    it('should use input_text type for system messages', () => {
      const systemMessage = new llm.ChatMessage({
        role: 'system',
        content: 'You are a helpful assistant.',
        id: 'test-system-msg',
      });

      const result = livekitItemToOpenAIItem(systemMessage) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('input_text');
    });

    it('should convert developer role to system role', () => {
      const developerMessage = new llm.ChatMessage({
        role: 'developer',
        content: 'System instructions.',
        id: 'test-developer-msg',
      });

      const result = livekitItemToOpenAIItem(developerMessage) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      const content = result.content[0]!;
      expect(content.type).toBe('input_text');
    });

    it('should handle multiple content items for assistant', () => {
      const multiContentMessage = new llm.ChatMessage({
        role: 'assistant',
        content: ['First part.', 'Second part.'],
        id: 'test-multi-msg',
      });

      const result = livekitItemToOpenAIItem(multiContentMessage) as api_proto.AssistantItem;

      expect(result.content).toHaveLength(2);
      const content0 = result.content[0]!;
      const content1 = result.content[1]!;
      expect(content0.type).toBe('output_text');
      expect(content1.type).toBe('output_text');
    });
  });

  describe('function_call items', () => {
    it('should convert function call items correctly', () => {
      const functionCall = new llm.FunctionCall({
        callId: 'call-123',
        name: 'get_weather',
        args: '{"location": "San Francisco"}',
        id: 'test-func-call',
      });

      const result = livekitItemToOpenAIItem(functionCall) as api_proto.FunctionCallItem;

      expect(result.type).toBe('function_call');
      expect(result.id).toBe('test-func-call');
      expect(result.call_id).toBe('call-123');
      expect(result.name).toBe('get_weather');
      expect(result.arguments).toBe('{"location": "San Francisco"}');
    });
  });

  describe('function_call_output items', () => {
    it('should convert function call output items correctly', () => {
      const functionOutput = new llm.FunctionCallOutput({
        callId: 'call-123',
        output: 'The weather in San Francisco is sunny.',
        isError: false,
        id: 'test-func-output',
      });

      const result = livekitItemToOpenAIItem(functionOutput) as api_proto.FunctionCallOutputItem;

      expect(result.type).toBe('function_call_output');
      expect(result.id).toBe('test-func-output');
      expect(result.call_id).toBe('call-123');
      expect(result.output).toBe('The weather in San Francisco is sunny.');
    });
  });
});
