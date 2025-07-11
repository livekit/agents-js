// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AudioContent,
  ChatContext,
  FunctionCall,
  FunctionCallOutput,
  type ImageContent,
} from './chat_context.js';

describe('ChatContext', () => {
  describe('toJSON', () => {
    let context: ChatContext;

    beforeEach(() => {
      context = new ChatContext();
    });

    it('should convert empty context to JSON', () => {
      const result = context.toJSON();
      expect(result).toEqual({ items: [] });
    });

    it('should exclude timestamps by default', () => {
      const message = context.addMessage({
        role: 'user',
        content: 'Hello',
        createdAt: 1234567890,
      });

      const result = context.toJSON();
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).not.toHaveProperty('createdAt');
      expect(result.items[0]).toMatchObject({
        id: message.id,
        type: 'message',
        role: 'user',
        content: ['Hello'],
        interrupted: false,
      });
    });

    it('should include timestamps when excludeTimestamp is false', () => {
      const createdAt = 1234567890;
      context.addMessage({
        role: 'user',
        content: 'Hello',
        createdAt,
      });

      const result = context.toJSON({ excludeTimestamp: false });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toHaveProperty('createdAt', createdAt);
    });

    it('should exclude image content by default', () => {
      const imageContent: ImageContent = {
        id: 'img_123',
        type: 'image_content',
        image: 'https://example.com/image.jpg',
        inferenceDetail: 'auto',
        _cache: {},
      };

      context.addMessage({
        role: 'user',
        content: ['Look at this image:', imageContent, 'What do you see?'],
      });

      const result = context.toJSON();
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.content).toEqual(['Look at this image:', 'What do you see?']);
      expect(result.items[0]!.content).not.toContainEqual(
        expect.objectContaining({ type: 'image_content' }),
      );
    });

    it('should include image content when excludeImage is false', () => {
      const imageContent: ImageContent = {
        id: 'img_123',
        type: 'image_content',
        image: 'https://example.com/image.jpg',
        inferenceDetail: 'high',
        inferenceWidth: 512,
        inferenceHeight: 512,
        mimeType: 'image/jpeg',
        _cache: {},
      };

      context.addMessage({
        role: 'user',
        content: ['Look at this:', imageContent],
      });

      const result = context.toJSON({ excludeImage: false });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.content).toHaveLength(2);
      expect(result.items[0]!.content[1]).toMatchObject({
        id: 'img_123',
        type: 'image_content',
        image: 'https://example.com/image.jpg',
        inferenceDetail: 'high',
        inferenceWidth: 512,
        inferenceHeight: 512,
        mimeType: 'image/jpeg',
      });
    });

    it('should exclude audio content by default', () => {
      const audioContent: AudioContent = {
        type: 'audio_content',
        frame: [], // Empty array for simplicity
        transcript: 'Hello world',
      };

      context.addMessage({
        role: 'user',
        content: ['Listen to this:', audioContent, 'What did you hear?'],
      });

      const result = context.toJSON();
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.content).toEqual(['Listen to this:', 'What did you hear?']);
      expect(result.items[0]!.content).not.toContainEqual(
        expect.objectContaining({ type: 'audio_content' }),
      );
    });

    it('should include audio content when excludeAudio is false', () => {
      const audioContent: AudioContent = {
        type: 'audio_content',
        frame: [],
        transcript: 'Hello world',
      };

      context.addMessage({
        role: 'user',
        content: ['Listen:', audioContent],
      });

      const result = context.toJSON({ excludeAudio: false });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.content).toHaveLength(2);
      expect(result.items[0]!.content[1]).toMatchObject({
        type: 'audio_content',
        frame: [],
        transcript: 'Hello world',
      });
    });

    it('should include function calls by default', () => {
      const functionCall = new FunctionCall({
        callId: 'call_123',
        name: 'get_weather',
        args: '{"location": "San Francisco"}',
      });

      const functionOutput = new FunctionCallOutput({
        callId: 'call_123',
        output: 'Sunny, 72°F',
        isError: false,
        name: 'get_weather',
      });

      context.insert([functionCall, functionOutput]);

      const result = context.toJSON();
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: functionCall.id,
        type: 'function_call',
        callId: 'call_123',
        name: 'get_weather',
        args: '{"location": "San Francisco"}',
      });
      expect(result.items[1]).toMatchObject({
        id: functionOutput.id,
        type: 'function_call_output',
        callId: 'call_123',
        output: 'Sunny, 72°F',
        isError: false,
        name: 'get_weather',
      });
    });

    it('should exclude function calls when excludeFunctionCall is true', () => {
      context.addMessage({ role: 'user', content: 'What is the weather?' });

      const functionCall = new FunctionCall({
        callId: 'call_123',
        name: 'get_weather',
        args: '{"location": "San Francisco"}',
      });

      const functionOutput = new FunctionCallOutput({
        callId: 'call_123',
        output: 'Sunny, 72°F',
        isError: false,
      });

      context.insert([functionCall, functionOutput]);

      context.addMessage({ role: 'assistant', content: 'The weather is sunny and 72°F.' });

      const result = context.toJSON({ excludeFunctionCall: true });
      expect(result.items).toHaveLength(2);
      expect(result.items.every((item) => item.type === 'message')).toBe(true);
      expect(result.items[0]!.role).toBe('user');
      expect(result.items[1]!.role).toBe('assistant');
    });

    it('should handle mixed content types with various options', () => {
      const imageContent: ImageContent = {
        id: 'img_456',
        type: 'image_content',
        image: 'data:image/png;base64,iVBORw0KG...',
        inferenceDetail: 'low',
        _cache: {},
      };

      const audioContent: AudioContent = {
        type: 'audio_content',
        frame: [],
        transcript: 'Test audio',
      };

      context.addMessage({
        role: 'user',
        content: ['Text part', imageContent, audioContent, 'Another text'],
      });

      // Test with default options (exclude image and audio)
      const result1 = context.toJSON();
      expect(result1.items[0]!.content).toEqual(['Text part', 'Another text']);

      // Test with only images excluded
      const result2 = context.toJSON({ excludeImage: true, excludeAudio: false });
      expect(result2.items[0]!.content).toHaveLength(3);
      expect(result2.items[0]!.content).toEqual(['Text part', audioContent, 'Another text']);

      // Test with nothing excluded
      const result3 = context.toJSON({ excludeImage: false, excludeAudio: false });
      expect(result3.items[0]!.content).toHaveLength(4);
      expect(result3.items[0]!.content).toEqual([
        'Text part',
        imageContent,
        audioContent,
        'Another text',
      ]);
    });

    it('should handle messages with different roles', () => {
      context.addMessage({ role: 'developer', content: 'Developer instructions' });
      context.addMessage({ role: 'system', content: 'System prompt' });
      context.addMessage({ role: 'user', content: 'User message' });
      context.addMessage({ role: 'assistant', content: 'Assistant response' });

      const result = context.toJSON();
      expect(result.items).toHaveLength(4);
      expect(result.items[0]!.role).toBe('developer');
      expect(result.items[1]!.role).toBe('system');
      expect(result.items[2]!.role).toBe('user');
      expect(result.items[3]!.role).toBe('assistant');
    });

    it('should preserve message properties', () => {
      const message = context.addMessage({
        role: 'user',
        content: 'Test message',
        id: 'custom_id_123',
        interrupted: true,
      });

      message.hash = new Uint8Array([1, 2, 3, 4]);

      const result = context.toJSON();
      expect(result.items[0]).toMatchObject({
        id: 'custom_id_123',
        type: 'message',
        role: 'user',
        content: ['Test message'],
        interrupted: true,
      });
    });

    it('should handle complex conversation flow', () => {
      // User asks a question
      context.addMessage({ role: 'user', content: 'What is the capital of France?' });

      // Assistant makes a function call
      const functionCall = new FunctionCall({
        callId: 'call_789',
        name: 'search_capital',
        args: '{"country": "France"}',
      });
      context.insert(functionCall);

      // Function returns result
      const functionOutput = new FunctionCallOutput({
        callId: 'call_789',
        output: 'Paris',
        isError: false,
        name: 'search_capital',
      });
      context.insert(functionOutput);

      // Assistant responds
      context.addMessage({ role: 'assistant', content: 'The capital of France is Paris.' });

      // Test with all items included
      const result1 = context.toJSON();
      expect(result1.items).toHaveLength(4);

      // Test with function calls excluded
      const result2 = context.toJSON({ excludeFunctionCall: true });
      expect(result2.items).toHaveLength(2);
      expect(result2.items[0]!.content).toEqual(['What is the capital of France?']);
      expect(result2.items[1]!.content).toEqual(['The capital of France is Paris.']);
    });

    it('should handle empty content arrays', () => {
      context.addMessage({ role: 'user', content: [] });

      const result = context.toJSON();
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.content).toEqual([]);
    });

    it('should handle function call with error output', () => {
      const functionCall = new FunctionCall({
        callId: 'call_error',
        name: 'failing_function',
        args: '{}',
      });

      const functionOutput = new FunctionCallOutput({
        callId: 'call_error',
        output: 'Error: Function failed',
        isError: true,
        name: 'failing_function',
      });

      context.insert([functionCall, functionOutput]);

      const result = context.toJSON({ excludeTimestamp: false });
      expect(result.items).toHaveLength(2);
      expect(result.items[1]).toMatchObject({
        type: 'function_call_output',
        callId: 'call_error',
        output: 'Error: Function failed',
        isError: true,
        name: 'failing_function',
      });
      expect(result.items[1]).toHaveProperty('createdAt');
    });
  });
});
