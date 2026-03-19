// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import type * as api_proto from './api_proto.js';
import { livekitItemToOpenAIItem } from './realtime_model.js';

describe('livekitItemToOpenAIItem', () => {
  describe('message items', () => {
    it('should use output_text type for assistant messages', async () => {
      const assistantMessage = new llm.ChatMessage({
        role: 'assistant',
        content: 'Hello, how can I help you?',
        id: 'test-assistant-msg',
      });

      const result = (await livekitItemToOpenAIItem(assistantMessage)) as api_proto.AssistantItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('assistant');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('output_text');
      expect((content as api_proto.OutputTextContent).text).toBe('Hello, how can I help you?');
    });

    it('should use input_text type for user messages', async () => {
      const userMessage = new llm.ChatMessage({
        role: 'user',
        content: 'What is the weather like?',
        id: 'test-user-msg',
      });

      const result = (await livekitItemToOpenAIItem(userMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('user');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('input_text');
      expect((content as api_proto.InputTextContent).text).toBe('What is the weather like?');
    });

    it('should use input_text type for system messages', async () => {
      const systemMessage = new llm.ChatMessage({
        role: 'system',
        content: 'You are a helpful assistant.',
        id: 'test-system-msg',
      });

      const result = (await livekitItemToOpenAIItem(systemMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('input_text');
    });

    it('should convert developer role to system role', async () => {
      const developerMessage = new llm.ChatMessage({
        role: 'developer',
        content: 'System instructions.',
        id: 'test-developer-msg',
      });

      const result = (await livekitItemToOpenAIItem(developerMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      const content = result.content[0]!;
      expect(content.type).toBe('input_text');
    });

    it('should handle multiple content items for assistant', async () => {
      const multiContentMessage = new llm.ChatMessage({
        role: 'assistant',
        content: ['First part.', 'Second part.'],
        id: 'test-multi-msg',
      });

      const result = (await livekitItemToOpenAIItem(
        multiContentMessage,
      )) as api_proto.AssistantItem;

      expect(result.content).toHaveLength(2);
      const content0 = result.content[0]!;
      const content1 = result.content[1]!;
      expect(content0.type).toBe('output_text');
      expect(content1.type).toBe('output_text');
    });

    it('should convert image content to input_image for user messages', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const userMessage = new llm.ChatMessage({
        role: 'user',
        content: [imageContent],
        id: 'test-image-msg',
      });

      const result = (await livekitItemToOpenAIItem(userMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('user');
      expect(result.content).toHaveLength(1);
      const content = result.content[0]!;
      expect(content.type).toBe('input_image');
      expect((content as api_proto.InputImageContent).image_url).toBe(
        `data:image/png;base64,${base64Data}`,
      );
    });

    it('should ignore image content for assistant messages', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const assistantMessage = new llm.ChatMessage({
        role: 'assistant',
        content: [imageContent],
        id: 'test-assistant-image-msg',
      });

      const result = (await livekitItemToOpenAIItem(assistantMessage)) as api_proto.AssistantItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('assistant');
      expect(result.content).toHaveLength(0);
    });

    it('should ignore image content for system messages', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const systemMessage = new llm.ChatMessage({
        role: 'system',
        content: [imageContent],
        id: 'test-system-image-msg',
      });

      const result = (await livekitItemToOpenAIItem(systemMessage)) as api_proto.SystemItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      expect(result.content).toHaveLength(0);
    });

    it('should ignore image content for developer messages mapped to system', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const developerMessage = new llm.ChatMessage({
        role: 'developer',
        content: [imageContent],
        id: 'test-developer-image-msg',
      });

      const result = (await livekitItemToOpenAIItem(developerMessage)) as api_proto.SystemItem;

      expect(result.type).toBe('message');
      expect(result.role).toBe('system');
      expect(result.content).toHaveLength(0);
    });

    it('should handle mixed text and image content', async () => {
      const base64Data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imageContent = llm.createImageContent({
        image: `data:image/png;base64,${base64Data}`,
        mimeType: 'image/png',
      });

      const userMessage = new llm.ChatMessage({
        role: 'user',
        content: ['Describe this image:', imageContent],
        id: 'test-mixed-msg',
      });

      const result = (await livekitItemToOpenAIItem(userMessage)) as api_proto.UserItem;

      expect(result.type).toBe('message');
      expect(result.content).toHaveLength(2);
      expect(result.content[0]!.type).toBe('input_text');
      expect(result.content[1]!.type).toBe('input_image');
    });
  });

  describe('function_call items', () => {
    it('should convert function call items correctly', async () => {
      const functionCall = new llm.FunctionCall({
        callId: 'call-123',
        name: 'get_weather',
        args: '{"location": "San Francisco"}',
        id: 'test-func-call',
      });

      const result = (await livekitItemToOpenAIItem(functionCall)) as api_proto.FunctionCallItem;

      expect(result.type).toBe('function_call');
      expect(result.id).toBe('test-func-call');
      expect(result.call_id).toBe('call-123');
      expect(result.name).toBe('get_weather');
      expect(result.arguments).toBe('{"location": "San Francisco"}');
    });
  });

  describe('function_call_output items', () => {
    it('should convert function call output items correctly', async () => {
      const functionOutput = new llm.FunctionCallOutput({
        callId: 'call-123',
        output: 'The weather in San Francisco is sunny.',
        isError: false,
        id: 'test-func-output',
      });

      const result = (await livekitItemToOpenAIItem(
        functionOutput,
      )) as api_proto.FunctionCallOutputItem;

      expect(result.type).toBe('function_call_output');
      expect(result.id).toBe('test-func-output');
      expect(result.call_id).toBe('call-123');
      expect(result.output).toBe('The weather in San Francisco is sunny.');
    });
  });
});
