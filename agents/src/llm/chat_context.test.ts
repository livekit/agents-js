// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  type AudioContent,
  ChatContext,
  type ChatItem,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
  type ImageContent,
  ReadonlyChatContext,
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

describe('ReadonlyChatContext with immutable array', () => {
  it('should have readonly property set to true', () => {
    const items: ChatItem[] = [
      new ChatMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Test'],
        interrupted: false,
        createdAt: Date.now(),
      }),
    ];
    const readonlyContext = new ReadonlyChatContext(items);

    expect(readonlyContext.readonly).toBe(true);
  });

  it('should prevent setting items property', () => {
    const items: ChatItem[] = [
      new ChatMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Test'],
        interrupted: false,
        createdAt: Date.now(),
      }),
    ];
    const readonlyContext = new ReadonlyChatContext(items);
    expect(() => {
      readonlyContext.items = [];
    }).toThrow(
      `Cannot set items on a read-only chat context. Please use .copy() and agent.update_chat_ctx() to modify the chat context.`,
    );
  });

  it('should prevent modifications through array methods', () => {
    const items: ChatItem[] = [
      new ChatMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Test'],
        interrupted: false,
        createdAt: Date.now(),
      }),
    ];
    const readonlyContext = new ReadonlyChatContext(items);
    const newItem = new ChatMessage({
      id: 'msg_2',
      role: 'assistant',
      content: ['Response'],
      interrupted: false,
      createdAt: Date.now(),
    });

    const mutableItems = readonlyContext.items;
    expect(() => mutableItems.push(newItem)).toThrow(
      'Cannot call push() on a read-only array. Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => mutableItems.pop()).toThrow(
      'Cannot call pop() on a read-only array. Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => mutableItems.shift()).toThrow(
      'Cannot call shift() on a read-only array. Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => mutableItems.unshift(newItem)).toThrow(
      'Cannot call unshift() on a read-only array. Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => mutableItems.splice(0, 1)).toThrow(
      'Cannot call splice() on a read-only array. Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => mutableItems.sort()).toThrow(
      'Cannot call sort() on a read-only array. Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => mutableItems.reverse()).toThrow(
      'Cannot call reverse() on a read-only array. Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => mutableItems.fill(newItem)).toThrow(
      'Cannot call fill() on a read-only array. Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => mutableItems.copyWithin(0, 1)).toThrow(
      'Cannot call copyWithin() on a read-only array. Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );
  });

  it('should prevent bracket notation assignment and deletion', () => {
    const items: ChatItem[] = [
      new ChatMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Test'],
        interrupted: false,
        createdAt: Date.now(),
      }),
    ];
    const readonlyContext = new ReadonlyChatContext(items);
    const newItem = new ChatMessage({
      id: 'msg_2',
      role: 'assistant',
      content: ['Response'],
      interrupted: false,
      createdAt: Date.now(),
    });

    expect(() => {
      readonlyContext.items[0] = newItem;
    }).toThrow(
      'Cannot assign to read-only array index "0". Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => {
      delete readonlyContext.items[0];
    }).toThrow(
      'Cannot delete read-only array index "0". Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );

    expect(() => {
      readonlyContext.items[99] = newItem;
    }).toThrow(
      'Cannot assign to read-only array index "99". Please use .copy() and agent.update_chat_ctx() to modify the chat context.',
    );
  });

  it('should allow read operations on the immutable array', () => {
    const items: ChatItem[] = [
      new ChatMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Test 1'],
        interrupted: false,
        createdAt: 1000,
      }),
      new ChatMessage({
        id: 'msg_2',
        role: 'assistant',
        content: ['Test 2'],
        interrupted: false,
        createdAt: 2000,
      }),
    ];
    const readonlyContext = new ReadonlyChatContext(items);

    expect(readonlyContext.items.length).toBe(2);
    expect(readonlyContext.items[0]).toEqual(items[0]);
    expect(readonlyContext.items[1]).toEqual(items[1]);
    expect(readonlyContext.items.find((item: ChatItem) => item.id === 'msg_2')).toEqual(items[1]);
    expect(readonlyContext.items.map((item: ChatItem) => item.id)).toEqual(['msg_1', 'msg_2']);
    expect(
      readonlyContext.items.filter(
        (item: ChatItem) => item.type === 'message' && item.role === 'user',
      ),
    ).toHaveLength(1);

    // forEach should work for reading
    const ids: string[] = [];
    readonlyContext.items.forEach((item) => ids.push(item.id));
    expect(ids).toEqual(['msg_1', 'msg_2']);
  });
});

describe('ChatContext.isEquivalent', () => {
  it('should return true for same reference', () => {
    const ctx = new ChatContext();
    ctx.addMessage({
      id: 'msg_1',
      role: 'user',
      content: 'Hello',
    });

    expect(ctx.isEquivalent(ctx)).toBe(true);
  });

  it('should return true for identical empty contexts', () => {
    const ctx1 = new ChatContext();
    const ctx2 = new ChatContext();

    expect(ctx1.isEquivalent(ctx2)).toBe(true);
  });

  it('should return false for contexts with different lengths', () => {
    const ctx1 = new ChatContext();
    ctx1.addMessage({
      id: 'msg_1',
      role: 'user',
      content: 'Hello',
    });

    const ctx2 = new ChatContext();
    ctx2.addMessage({
      id: 'msg_1',
      role: 'user',
      content: 'Hello',
    });
    ctx2.addMessage({
      id: 'msg_2',
      role: 'assistant',
      content: 'Hi',
    });

    expect(ctx1.isEquivalent(ctx2)).toBe(false);
  });

  it('should return false for contexts with different item IDs', () => {
    const ctx1 = new ChatContext();
    ctx1.addMessage({
      id: 'msg_1',
      role: 'user',
      content: 'Hello',
    });

    const ctx2 = new ChatContext();
    ctx2.addMessage({
      id: 'msg_2',
      role: 'user',
      content: 'Hello',
    });

    expect(ctx1.isEquivalent(ctx2)).toBe(false);
  });

  it('should return false for contexts with different item types', () => {
    const ctx1 = new ChatContext();
    ctx1.addMessage({
      id: 'msg_1',
      role: 'user',
      content: 'Hello',
    });

    const ctx2 = new ChatContext();
    ctx2.insert(
      new FunctionCall({
        id: 'msg_1',
        callId: 'call_1',
        name: 'test',
        args: '{}',
      }),
    );

    expect(ctx1.isEquivalent(ctx2)).toBe(false);
  });

  describe('message comparison', () => {
    it('should return true for identical messages', () => {
      const ctx1 = new ChatContext();
      ctx1.addMessage({
        id: 'msg_1',
        role: 'user',
        content: 'Hello',
        interrupted: false,
      });

      const ctx2 = new ChatContext();
      ctx2.addMessage({
        id: 'msg_1',
        role: 'user',
        content: 'Hello',
        interrupted: false,
      });

      expect(ctx1.isEquivalent(ctx2)).toBe(true);
    });

    it('should return false for messages with different roles', () => {
      const ctx1 = new ChatContext();
      ctx1.addMessage({
        id: 'msg_1',
        role: 'user',
        content: 'Hello',
      });

      const ctx2 = new ChatContext();
      ctx2.addMessage({
        id: 'msg_1',
        role: 'assistant',
        content: 'Hello',
      });

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should return false for messages with different interrupted flags', () => {
      const ctx1 = new ChatContext();
      ctx1.addMessage({
        id: 'msg_1',
        role: 'user',
        content: 'Hello',
        interrupted: false,
      });

      const ctx2 = new ChatContext();
      ctx2.addMessage({
        id: 'msg_1',
        role: 'user',
        content: 'Hello',
        interrupted: true,
      });

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should return false for messages with different content', () => {
      const ctx1 = new ChatContext();
      ctx1.addMessage({
        id: 'msg_1',
        role: 'user',
        content: 'Hello',
      });

      const ctx2 = new ChatContext();
      ctx2.addMessage({
        id: 'msg_1',
        role: 'user',
        content: 'World',
      });

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should return true for messages with identical array content', () => {
      const ctx1 = new ChatContext();
      ctx1.addMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Hello', 'World'],
      });

      const ctx2 = new ChatContext();
      ctx2.addMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Hello', 'World'],
      });

      expect(ctx1.isEquivalent(ctx2)).toBe(true);
    });

    it('should return false for messages with different array content', () => {
      const ctx1 = new ChatContext();
      ctx1.addMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Hello', 'World'],
      });

      const ctx2 = new ChatContext();
      ctx2.addMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Hello'],
      });

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should return true for messages with identical image content', () => {
      const imageContent: ImageContent = {
        id: 'img_1',
        type: 'image_content',
        image: 'https://example.com/image.jpg',
        inferenceDetail: 'high',
        inferenceWidth: 1024,
        inferenceHeight: 768,
        mimeType: 'image/jpeg',
        _cache: {},
      };

      const ctx1 = new ChatContext();
      ctx1.addMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Check this:', imageContent],
      });

      const ctx2 = new ChatContext();
      ctx2.addMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Check this:', { ...imageContent }],
      });

      expect(ctx1.isEquivalent(ctx2)).toBe(true);
    });

    it('should return false for messages with different image content', () => {
      const imageContent1: ImageContent = {
        id: 'img_1',
        type: 'image_content',
        image: 'https://example.com/image1.jpg',
        inferenceDetail: 'high',
        _cache: {},
      };

      const imageContent2: ImageContent = {
        id: 'img_2',
        type: 'image_content',
        image: 'https://example.com/image2.jpg',
        inferenceDetail: 'high',
        _cache: {},
      };

      const ctx1 = new ChatContext();
      ctx1.addMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Check this:', imageContent1],
      });

      const ctx2 = new ChatContext();
      ctx2.addMessage({
        id: 'msg_1',
        role: 'user',
        content: ['Check this:', imageContent2],
      });

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });
  });

  describe('function call comparison', () => {
    it('should return true for identical function calls', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{"location": "Paris"}',
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{"location": "Paris"}',
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(true);
    });

    it('should return false for function calls with different names', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{}',
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_time',
          args: '{}',
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should return false for function calls with different call IDs', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{}',
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_2',
          name: 'get_weather',
          args: '{}',
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should return false for function calls with different arguments', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{"location": "Paris"}',
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{"location": "London"}',
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should ignore timestamps', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{}',
          createdAt: 1000,
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{}',
          createdAt: 2000,
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(true);
    });
  });

  describe('function call output comparison', () => {
    it('should return true for identical function call outputs', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{"temperature": 22}',
          isError: false,
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{"temperature": 22}',
          isError: false,
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(true);
    });

    it('should return false for function call outputs with different names', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{}',
          isError: false,
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_time',
          output: '{}',
          isError: false,
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should return false for function call outputs with different call IDs', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{}',
          isError: false,
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_2',
          name: 'get_weather',
          output: '{}',
          isError: false,
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should return false for function call outputs with different output values', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{"temperature": 22}',
          isError: false,
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{"temperature": 25}',
          isError: false,
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should return false for function call outputs with different error flags', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: 'Error occurred',
          isError: false,
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: 'Error occurred',
          isError: true,
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(false);
    });

    it('should ignore timestamps', () => {
      const ctx1 = new ChatContext();
      ctx1.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{}',
          isError: false,
          createdAt: 1000,
        }),
      );

      const ctx2 = new ChatContext();
      ctx2.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{}',
          isError: false,
          createdAt: 2000,
        }),
      );

      expect(ctx1.isEquivalent(ctx2)).toBe(true);
    });
  });

  describe('complex context comparison', () => {
    it('should return true for identical complex contexts', () => {
      const ctx1 = new ChatContext();
      ctx1.addMessage({
        id: 'msg_1',
        role: 'user',
        content: 'What is the weather?',
      });
      ctx1.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{"location": "Paris"}',
        }),
      );
      ctx1.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{"temperature": 22}',
          isError: false,
        }),
      );
      ctx1.addMessage({
        id: 'msg_2',
        role: 'assistant',
        content: 'The weather is 22°C',
      });

      const ctx2 = new ChatContext();
      ctx2.addMessage({
        id: 'msg_1',
        role: 'user',
        content: 'What is the weather?',
      });
      ctx2.insert(
        new FunctionCall({
          id: 'func_1',
          callId: 'call_1',
          name: 'get_weather',
          args: '{"location": "Paris"}',
        }),
      );
      ctx2.insert(
        new FunctionCallOutput({
          id: 'output_1',
          callId: 'call_1',
          name: 'get_weather',
          output: '{"temperature": 22}',
          isError: false,
        }),
      );
      ctx2.addMessage({
        id: 'msg_2',
        role: 'assistant',
        content: 'The weather is 22°C',
      });

      expect(ctx1.isEquivalent(ctx2)).toBe(true);
    });
  });
});
