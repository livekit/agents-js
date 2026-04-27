// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as api_proto from './api_proto.js';
import { RealtimeModel, livekitItemToOpenAIItem } from './realtime_model.js';

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

describe('RealtimeSession.updateOptions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stubTaskRuntime = () => {
    // Prevent background realtime tasks from opening network connections in unit tests.
    vi.spyOn(llm, 'RealtimeSession', 'get');
    const agentsModule = require('@livekit/agents') as typeof import('@livekit/agents'); // eslint-disable-line @typescript-eslint/no-require-imports
    vi.spyOn(agentsModule.Task, 'from').mockReturnValue({
      cancel: vi.fn(),
      done: true,
      result: Promise.resolve(undefined),
    } as unknown as import('@livekit/agents').Task<void>);
  };

  it('emits session.update when toolChoice changes', () => {
    stubTaskRuntime();

    const model = new RealtimeModel({ apiKey: 'test-key' });
    const session = model.session() as unknown as { updateOptions: (opts: { toolChoice?: llm.ToolChoice }) => void; sendEvent: (event: api_proto.ClientEvent) => void };
    const sendEventSpy = vi.spyOn(session, 'sendEvent');
    sendEventSpy.mockClear();

    session.updateOptions({ toolChoice: 'required' });

    expect(sendEventSpy).toHaveBeenCalledTimes(1);
    expect(sendEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.update',
        session: expect.objectContaining({
          type: 'realtime',
          tool_choice: 'required',
        }),
      }),
    );
  });

  it('does not emit session.update when toolChoice is unchanged', () => {
    stubTaskRuntime();

    const model = new RealtimeModel({ apiKey: 'test-key' });
    const session = model.session() as unknown as { updateOptions: (opts: { toolChoice?: llm.ToolChoice }) => void; sendEvent: (event: api_proto.ClientEvent) => void };
    const sendEventSpy = vi.spyOn(session, 'sendEvent');
    sendEventSpy.mockClear();

    session.updateOptions({ toolChoice: 'auto' });

    expect(sendEventSpy).not.toHaveBeenCalled();
  });

  it('keeps toolChoice state isolated across sessions from same model', () => {
    stubTaskRuntime();

    const model = new RealtimeModel({ apiKey: 'test-key' });
    const sessionA = model.session() as unknown as {
      updateOptions: (opts: { toolChoice?: llm.ToolChoice }) => void;
      sendEvent: (event: api_proto.ClientEvent) => void;
      _options: { toolChoice?: llm.ToolChoice };
    };
    const sessionB = model.session() as unknown as {
      updateOptions: (opts: { toolChoice?: llm.ToolChoice }) => void;
      sendEvent: (event: api_proto.ClientEvent) => void;
      _options: { toolChoice?: llm.ToolChoice };
    };

    const sendEventSpyA = vi.spyOn(sessionA, 'sendEvent');
    const sendEventSpyB = vi.spyOn(sessionB, 'sendEvent');
    sendEventSpyA.mockClear();
    sendEventSpyB.mockClear();

    sessionA.updateOptions({ toolChoice: 'required' });

    expect(sessionA._options.toolChoice).toBe('required');
    expect(sessionB._options.toolChoice).toBe('auto');
    expect(sendEventSpyA).toHaveBeenCalledTimes(1);
    expect(sendEventSpyB).toHaveBeenCalledTimes(0);

    sessionB.updateOptions({ toolChoice: 'required' });
    expect(sendEventSpyB).toHaveBeenCalledTimes(1);
  });
});
