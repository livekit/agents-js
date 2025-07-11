// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  type AudioContent,
  ChatContext,
  FunctionCall,
  FunctionCallOutput,
  type ImageContent,
} from './chat_context.js';

describe('ChatContext.toJSON', () => {
  it('should match snapshot for empty context', () => {
    const context = new ChatContext();
    expect(context.toJSON()).toMatchSnapshot();
  });

  it('should match snapshot for simple conversation', () => {
    const context = new ChatContext();

    context.addMessage({
      id: 'msg_system_1',
      role: 'system',
      content: 'You are a helpful assistant.',
      createdAt: 1000000000,
    });

    context.addMessage({
      id: 'msg_user_1',
      role: 'user',
      content: 'Hello, how are you?',
      createdAt: 1000000001,
    });

    context.addMessage({
      id: 'msg_assistant_1',
      role: 'assistant',
      content: "I'm doing well, thank you! How can I help you today?",
      createdAt: 1000000002,
    });

    expect(context.toJSON()).toMatchSnapshot('simple-conversation-no-timestamps');

    expect(context.toJSON({ excludeTimestamp: false })).toMatchSnapshot(
      'simple-conversation-with-timestamps',
    );
  });

  it('should match snapshot for multimodal content', () => {
    const context = new ChatContext();

    const imageContent: ImageContent = {
      id: 'img_test_1',
      type: 'image_content',
      image: 'https://example.com/test-image.jpg',
      inferenceDetail: 'high',
      inferenceWidth: 1024,
      inferenceHeight: 768,
      mimeType: 'image/jpeg',
      _cache: {},
    };

    const audioContent: AudioContent = {
      type: 'audio_content',
      frame: [], // This won't be included in JSON
      transcript: 'This is a test audio transcript',
    };

    context.addMessage({
      id: 'msg_user_2',
      role: 'user',
      content: [
        'Check out this image and audio:',
        imageContent,
        audioContent,
        'What do you think?',
      ],
      createdAt: 2000000000,
    });

    expect(context.toJSON()).toMatchSnapshot('multimodal-default-exclusions');

    expect(
      context.toJSON({
        excludeImage: false,
        excludeAudio: true,
      }),
    ).toMatchSnapshot('multimodal-with-images-only');

    expect(
      context.toJSON({
        excludeImage: true,
        excludeAudio: false,
      }),
    ).toMatchSnapshot('multimodal-with-audio-only');

    expect(
      context.toJSON({
        excludeImage: false,
        excludeAudio: false,
        excludeTimestamp: false,
      }),
    ).toMatchSnapshot('multimodal-full-content');
  });

  it('should match snapshot for function calls', () => {
    const context = new ChatContext();

    context.addMessage({
      id: 'msg_user_3',
      role: 'user',
      content: "What's the weather in Paris?",
      createdAt: 3000000000,
    });

    const functionCall = new FunctionCall({
      id: 'func_call_1',
      callId: 'call_weather_123',
      name: 'get_weather',
      args: '{"location": "Paris, France", "unit": "celsius"}',
      createdAt: 3000000001,
    });
    context.insert(functionCall);

    const functionOutput = new FunctionCallOutput({
      id: 'func_output_1',
      callId: 'call_weather_123',
      name: 'get_weather',
      output: '{"temperature": 22, "condition": "partly cloudy", "humidity": 65}',
      isError: false,
      createdAt: 3000000002,
    });
    context.insert(functionOutput);

    context.addMessage({
      id: 'msg_assistant_2',
      role: 'assistant',
      content: 'The weather in Paris is currently 22°C and partly cloudy with 65% humidity.',
      createdAt: 3000000003,
    });

    expect(context.toJSON()).toMatchSnapshot('conversation-with-function-calls');

    expect(
      context.toJSON({
        excludeFunctionCall: true,
      }),
    ).toMatchSnapshot('conversation-without-function-calls');

    expect(
      context.toJSON({
        excludeTimestamp: false,
      }),
    ).toMatchSnapshot('conversation-with-function-calls-and-timestamps');
  });

  it('should match snapshot for edge cases', () => {
    const context = new ChatContext();

    context.addMessage({
      id: 'msg_empty_1',
      role: 'user',
      content: [],
      createdAt: 5000000000,
    });

    const silentAudio: AudioContent = {
      type: 'audio_content',
      frame: [],
      transcript: undefined,
    };

    context.addMessage({
      id: 'msg_silent_audio',
      role: 'user',
      content: [silentAudio],
      createdAt: 5000000001,
    });

    context.addMessage({
      id: 'msg_multi_text',
      role: 'assistant',
      content: ['Part 1. ', 'Part 2. ', 'Part 3.'],
      createdAt: 5000000002,
    });

    const minimalCall = new FunctionCall({
      id: 'func_minimal',
      callId: 'minimal',
      name: 'test',
      args: '{}',
      createdAt: 5000000003,
    });
    context.insert(minimalCall);

    const namelessOutput = new FunctionCallOutput({
      id: 'func_output_nameless',
      callId: 'minimal',
      output: 'OK',
      isError: false,
      createdAt: 5000000004,
    });
    context.insert(namelessOutput);

    context.addMessage({
      id: 'msg_special_chars',
      role: 'user',
      content:
        'Test with special chars: \n\t\r "quotes" \'apostrophes\' \\backslashes\\ {braces} [brackets]',
      createdAt: 5000000005,
    });

    expect(context.toJSON()).toMatchSnapshot('edge-cases-default');
    expect(
      context.toJSON({
        excludeTimestamp: false,
        excludeAudio: false,
      }),
    ).toMatchSnapshot('edge-cases-with-details');
  });

  it('should match snapshot for message property variations', () => {
    const context = new ChatContext();

    context.addMessage({
      id: 'custom-message-id-123',
      role: 'user',
      content: 'Message with custom ID',
      createdAt: 6000000000,
    });

    context.addMessage({
      id: 'msg_interrupted',
      role: 'assistant',
      content: 'This response was interrupted...',
      interrupted: true,
      createdAt: 6000000001,
    });

    context.addMessage({
      id: 'msg_dev_2',
      role: 'developer',
      content: 'Developer message',
      createdAt: 6000000002,
    });

    context.addMessage({
      id: 'msg_system_3',
      role: 'system',
      content: 'System message',
      createdAt: 6000000003,
    });

    const detailedImage: ImageContent = {
      id: 'img_detailed',
      type: 'image_content',
      image: 'https://example.com/image.jpg',
      inferenceDetail: 'low',
      inferenceWidth: 512,
      inferenceHeight: 512,
      mimeType: 'image/png',
      _cache: { cached: true },
    };

    context.addMessage({
      id: 'msg_with_image',
      role: 'user',
      content: ['Image with all properties:', detailedImage],
      createdAt: 6000000004,
    });

    expect(context.toJSON()).toMatchSnapshot('message-properties-default');
    expect(
      context.toJSON({
        excludeImage: false,
        excludeTimestamp: false,
      }),
    ).toMatchSnapshot('message-properties-full');
  });
});
