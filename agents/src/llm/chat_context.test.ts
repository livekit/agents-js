// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { stripExprMarkup } from '../tts/provider_format.js';
import { INSTRUCTIONS_MESSAGE_ID, applyInstructionsModality } from '../voice/generation.js';
import { FakeLLM } from '../voice/testing/fake_llm.js';
import {
  type AudioContent,
  ChatContext,
  type ChatItem,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
  type ImageContent,
  Instructions,
  ReadonlyChatContext,
  concatInstructions,
  isInstructions,
  renderInstructions,
} from './chat_context.js';
import { ProviderTool, ToolContext, tool } from './tool_context.js';

initializeLogger({ pretty: false, level: 'error' });

const summaryXml = (summary: string) =>
  ['<chat_history_summary>', summary, '</chat_history_summary>'].join('\n');

const mixedMarkup =
  '<expr type="expression" label="happy"/> Press [Enter] to see <b>bold</b>, ' +
  'read [the docs](https://docs.livekit.io), then 1 < 2. <break time="1s"/> ' +
  '<expr type="prosody" label="whisper">keep it secret</expr>';

const mixedMarkupClean =
  ' Press [Enter] to see <b>bold</b>, ' +
  'read [the docs](https://docs.livekit.io), then 1 < 2. <break time="1s"/> ' +
  'keep it secret';

class TrackingFakeLLM extends FakeLLM {
  chatCalls = 0;

  chat(...args: Parameters<FakeLLM['chat']>) {
    this.chatCalls += 1;
    return super.chat(...args);
  }
}

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

describe('stripExprMarkup and ChatMessage text content', () => {
  it('stripExprMarkup only touches expr tags', () => {
    expect(stripExprMarkup(mixedMarkup)).toBe(mixedMarkupClean);
  });

  it('stripExprMarkup is a noop without expr tags', () => {
    const text = 'plain text with [brackets] and <sound value="laugh"/>';
    expect(stripExprMarkup(text)).toBe(text);
  });

  it('strips an unmatched opening expr marker', () => {
    expect(stripExprMarkup('Alpha <expr type="prosody" label="whisper">bravo')).toBe('Alpha bravo');
  });

  it('strips an unmatched closing expr marker', () => {
    expect(stripExprMarkup('Alpha </expr>bravo')).toBe('Alpha bravo');
  });

  it('strips a marker assembled from stream-split chunks', () => {
    const chunks = ['Alpha <ex', 'pr type="break" label="1s"/> bravo'];
    expect(stripExprMarkup(chunks.join(''))).toBe('Alpha  bravo');
  });

  it('strips expr tags from assistant textContent only', () => {
    const msg = ChatMessage.create({ role: 'assistant', content: [mixedMarkup] });

    expect(msg.textContent).toBe(mixedMarkupClean);
    expect(msg.rawTextContent).toBe(mixedMarkup);
  });

  it.each(['user', 'system', 'developer'] as const)('keeps %s textContent raw', (role) => {
    const msg = ChatMessage.create({ role, content: [mixedMarkup] });

    expect(msg.textContent).toBe(mixedMarkup);
    expect(msg.rawTextContent).toBe(mixedMarkup);
  });

  it('returns undefined without text content', () => {
    const msg = ChatMessage.create({ role: 'assistant', content: [] });

    expect(msg.textContent).toBeUndefined();
    expect(msg.rawTextContent).toBeUndefined();
  });

  it('toJSON stripMarkup is expr-only and assistant-only', () => {
    const chatCtx = new ChatContext();
    chatCtx.addMessage({ role: 'user', content: [mixedMarkup] });
    chatCtx.addMessage({ role: 'assistant', content: [mixedMarkup] });

    const stripped = chatCtx.toJSON({ stripMarkup: true });
    expect(stripped.items).toEqual([
      expect.objectContaining({ content: [mixedMarkup], role: 'user' }),
      expect.objectContaining({ content: [mixedMarkupClean], role: 'assistant' }),
    ]);

    const raw = chatCtx.toJSON();
    expect(raw.items).toEqual([
      expect.objectContaining({ content: [mixedMarkup], role: 'user' }),
      expect.objectContaining({ content: [mixedMarkup], role: 'assistant' }),
    ]);
  });
});

describe('ChatContext._summarize', () => {
  it('includes function calls in the summarization source and keeps chronological order', async () => {
    const ctx = new ChatContext();
    ctx.addMessage({ role: 'system', content: 'System prompt', createdAt: 0 });
    ctx.addMessage({ role: 'user', content: 'hello', createdAt: 1000 });
    ctx.addMessage({ role: 'assistant', content: 'hi there', createdAt: 2000 });
    ctx.insert(
      FunctionCall.create({
        callId: 'call_1',
        name: 'lookup',
        args: '{"order":"123"}',
        createdAt: 2500,
      }),
    );
    ctx.insert(
      new FunctionCallOutput({
        callId: 'call_1',
        name: 'lookup',
        output: '{"status":"delivered"}',
        isError: false,
        createdAt: 2600,
      }),
    );
    ctx.addMessage({ role: 'user', content: 'my color is blue', createdAt: 3000 });
    ctx.addMessage({ role: 'assistant', content: 'noted', createdAt: 4000 });

    const fake = new FakeLLM([
      {
        input: [
          'Conversation to summarize:',
          '',
          '<user>',
          'hello',
          '</user>',
          '<assistant>',
          'hi there',
          '</assistant>',
          '<function_call name="lookup" call_id="call_1">',
          '{"order":"123"}',
          '</function_call>',
          '<function_call_output name="lookup" call_id="call_1">',
          '{"status":"delivered"}',
          '</function_call_output>',
        ].join('\n'),
        content: 'condensed head',
      },
    ]);

    await ctx._summarize(fake, { keepLastTurns: 1 });

    const summary = ctx.items.find(
      (item) =>
        item.type === 'message' && item.role === 'assistant' && item.extra?.is_summary === true,
    );
    expect(summary).toBeDefined();
    if (!summary || summary.type !== 'message') {
      throw new Error('summary message is missing');
    }

    expect(summary.textContent).toBe(summaryXml('condensed head'));
    expect(summary.createdAt).toBeCloseTo(2999.999999, 6);
    expect(ctx.items.filter((item) => item.type === 'function_call')).toHaveLength(0);
    expect(ctx.items.filter((item) => item.type === 'function_call_output')).toHaveLength(0);

    const createdAts = ctx.items.map((item) => item.createdAt);
    const sorted = [...createdAts].sort((a, b) => a - b);
    expect(createdAts).toEqual(sorted);
  });

  it('preserves interleaved tool items that belong to the recent tail', async () => {
    const ctx = new ChatContext();
    ctx.addMessage({ role: 'system', content: 'System prompt', createdAt: 0 });
    ctx.addMessage({ role: 'user', content: 'my earbuds are broken', createdAt: 1000 });
    ctx.addMessage({
      role: 'assistant',
      content: 'Can you share your order number?',
      createdAt: 2000,
    });
    ctx.addMessage({ role: 'user', content: 'Order #123', createdAt: 3000 });
    ctx.insert(
      FunctionCall.create({
        callId: 'call_2',
        name: 'lookup_order',
        args: '{"order":"123"}',
        createdAt: 3500,
      }),
    );
    ctx.insert(
      new FunctionCallOutput({
        callId: 'call_2',
        name: 'lookup_order',
        output: '{"status":"delivered"}',
        isError: false,
        createdAt: 3600,
      }),
    );
    ctx.addMessage({
      role: 'assistant',
      content: 'Found your order. Let me check the warranty.',
      createdAt: 4000,
    });
    ctx.addMessage({ role: 'user', content: 'Thanks.', createdAt: 5000 });
    ctx.addMessage({ role: 'assistant', content: 'You are under warranty.', createdAt: 6000 });

    const fake = new FakeLLM([
      {
        input: [
          'Conversation to summarize:',
          '',
          '<user>',
          'my earbuds are broken',
          '</user>',
          '<assistant>',
          'Can you share your order number?',
          '</assistant>',
        ].join('\n'),
        content: 'older summary',
      },
    ]);

    await ctx._summarize(fake, { keepLastTurns: 2 });

    const functionItems = ctx.items.filter(
      (item) => item.type === 'function_call' || item.type === 'function_call_output',
    );
    expect(functionItems).toHaveLength(2);
    expect(functionItems.map((item) => item.createdAt)).toEqual([3500, 3600]);

    const rawTailMessages = ctx.items.filter(
      (item) =>
        item.type === 'message' &&
        (item.role === 'user' || item.role === 'assistant') &&
        item.extra?.is_summary !== true,
    );
    expect(rawTailMessages).toHaveLength(4);
    expect(rawTailMessages.map((item) => (item as ChatMessage).textContent)).toEqual([
      'Order #123',
      'Found your order. Let me check the warranty.',
      'Thanks.',
      'You are under warranty.',
    ]);

    const createdAts = ctx.items.map((item) => item.createdAt);
    const sorted = [...createdAts].sort((a, b) => a - b);
    expect(createdAts).toEqual(sorted);
  });

  it('skips summarization when the recent-turn budget already covers the history', async () => {
    const ctx = new ChatContext();
    ctx.addMessage({ role: 'system', content: 'System prompt', createdAt: 0 });
    ctx.addMessage({ role: 'user', content: 'hello', createdAt: 1000 });
    ctx.addMessage({ role: 'assistant', content: 'hi there', createdAt: 2000 });

    const llm = new TrackingFakeLLM();
    const originalIds = ctx.items.map((item) => item.id);

    const result = await ctx._summarize(llm, { keepLastTurns: 1 });

    expect(result).toBe(ctx);
    expect(llm.chatCalls).toBe(0);
    expect(ctx.items.map((item) => item.id)).toEqual(originalIds);
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

describe('Instructions', () => {
  it('constructs from an object with audio and text variants', () => {
    const instr = new Instructions({ audio: 'audio variant', text: 'text variant' });

    expect(instr.audio).toBe('audio variant');
    expect(instr.text).toBe('text variant');
    expect(instr.value).toBe('audio variant');
  });

  it('identifies Instructions with a type guard', () => {
    const instr = new Instructions({ audio: 'audio variant', text: 'text variant' });

    expect(isInstructions(instr)).toBe(true);
    expect(isInstructions('audio variant')).toBe(false);
    expect(isInstructions({ type: 'instructions', audio: 'audio variant' })).toBe(false);
  });

  it('tpl propagates Instructions interpolations into audio and text variants', () => {
    const instr = Instructions.tpl`persona
${new Instructions({ audio: 'audio rules', text: 'text rules' })}
extra`;

    expect(instr).toBeInstanceOf(Instructions);
    expect(instr.audio).toBe('persona\naudio rules\nextra');
    expect(instr.text).toBe('persona\ntext rules\nextra');
    expect(instr.value).toBe('persona\naudio rules\nextra');
    expect(instr.asModality('text').value).toBe('persona\ntext rules\nextra');
  });

  it('tpl preserves audio-only interpolation as audio-only output', () => {
    const instr = Instructions.tpl`prefix ${new Instructions({ audio: 'same' })} suffix`;

    expect(instr.toJSON()).toEqual({ type: 'instructions', audio: 'prefix same suffix' });
    expect(instr.audio).toBe('prefix same suffix');
    expect(instr.text).toBe('prefix same suffix');
  });

  it('tpl interpolates primitive values into both variants', () => {
    const instr = Instructions.tpl`date=${'2026-05-13'} enabled=${true} count=${3}`;

    expect(instr.toJSON()).toEqual({
      type: 'instructions',
      audio: 'date=2026-05-13 enabled=true count=3',
    });
    expect(instr.audio).toBe('date=2026-05-13 enabled=true count=3');
    expect(instr.text).toBe('date=2026-05-13 enabled=true count=3');
    expect(instr.value).toBe('date=2026-05-13 enabled=true count=3');
  });

  it('tpl combines multiple modality-aware interpolations', () => {
    const instr = Instructions.tpl`${new Instructions({ audio: 'audio A', text: 'text A' })} / ${new Instructions({ audio: 'audio B', text: 'text B' })}`;

    expect(instr.audio).toBe('audio A / audio B');
    expect(instr.text).toBe('text A / text B');
    expect(instr.value).toBe('audio A / audio B');
  });

  it('tpl preserves the current rendered value of resolved interpolations', () => {
    const resolved = new Instructions({ audio: 'audio rules', text: 'text rules' }).asModality(
      'text',
    );
    const instr = Instructions.tpl`prefix ${resolved} suffix`;

    expect(instr.audio).toBe('prefix audio rules suffix');
    expect(instr.text).toBe('prefix text rules suffix');
    expect(instr.value).toBe('prefix text rules suffix');
  });

  it('tpl stringifies null and undefined values like template literals', () => {
    const instr = Instructions.tpl`null=${null} undefined=${undefined}`;

    expect(instr.toJSON()).toEqual({
      type: 'instructions',
      audio: 'null=null undefined=undefined',
    });
    expect(instr.audio).toBe('null=null undefined=undefined');
    expect(instr.text).toBe('null=null undefined=undefined');
  });

  it('tpl renders each modality variant exactly once', () => {
    const instr = Instructions.tpl`${'You are a helpful assistant.'}

${new Instructions({ audio: 'Handle noisy voice input.', text: 'Handle typed input.' })}`;

    expect(renderInstructions(instr, 'audio')).toBe(
      'You are a helpful assistant.\n\nHandle noisy voice input.',
    );
    expect(renderInstructions(instr, 'text')).toBe(
      'You are a helpful assistant.\n\nHandle typed input.',
    );
    expect(renderInstructions(instr, 'audio').split('You are a helpful assistant.')).toHaveLength(
      2,
    );
  });

  it('tpl without Instructions interpolations is an audio-only render', () => {
    const instr = Instructions.tpl`Hello ${'Alex'}`;

    expect(instr.toJSON()).toEqual({ type: 'instructions', audio: 'Hello Alex' });
    expect(instr.audio).toBe('Hello Alex');
    expect(instr.text).toBe('Hello Alex');
    expect(renderInstructions(instr)).toBe('Hello Alex');
    expect(renderInstructions(instr, 'audio')).toBe('Hello Alex');
  });

  it('tpl collapses identical modality variants', () => {
    const instr = Instructions.tpl`${'You are a helpful assistant.'}

${new Instructions({ audio: 'shared note', text: 'shared note' })}`;

    expect(instr.toJSON()).toEqual({
      type: 'instructions',
      audio: 'You are a helpful assistant.\n\nshared note',
    });
    expect(renderInstructions(instr)).toBe('You are a helpful assistant.\n\nshared note');
    expect(renderInstructions(instr, 'audio')).toBe('You are a helpful assistant.\n\nshared note');
  });

  it('serializes to a dict with both variants and round-trips through toJSON', () => {
    const instr = new Instructions({ audio: 'audio variant', text: 'text variant' });

    const ctx = new ChatContext([ChatMessage.create({ role: 'system', content: [instr] })]);
    const data = ctx.toJSON();
    const items = (data.items as Record<string, unknown>[])!;
    const content = (items[0]!.content as Record<string, unknown>[])![0]!;

    expect(content).toEqual({
      type: 'instructions',
      audio: 'audio variant',
      text: 'text variant',
    });
  });

  it('omits the text key in toJSON when only audio variant is provided', () => {
    const instr = new Instructions({ audio: 'audio only' });
    expect(instr.toJSON()).toEqual({ type: 'instructions', audio: 'audio only' });
  });

  it('falls back text -> audio when no text variant is provided', () => {
    const instr = new Instructions({ audio: 'audio only' });
    expect(instr.audio).toBe('audio only');
    expect(instr.text).toBe('audio only');
    expect(instr.value).toBe('audio only');
  });

  it('renderInstructions returns strings and resolved Instructions values explicitly', () => {
    const instr = new Instructions({ audio: 'audio instructions', text: 'text instructions' });

    expect(renderInstructions('plain instructions')).toBe('plain instructions');
    expect(renderInstructions(instr)).toBe('audio instructions');
    expect(renderInstructions(instr, 'audio')).toBe('audio instructions');
    expect(renderInstructions(instr, 'text')).toBe('text instructions');
  });

  it('concatenates two Instructions, propagating both variants', () => {
    const a = new Instructions({ audio: 'audio A', text: 'text A' });
    const b = new Instructions({ audio: 'audio B', text: 'text B' });
    const result = a.concat(b);
    expect(result).toBeInstanceOf(Instructions);
    expect(result.audio).toBe('audio Aaudio B');
    expect(result.text).toBe('text Atext B');
  });

  it('concatenates Instructions + string, propagating both variants', () => {
    const instr = new Instructions({ audio: 'audio', text: 'text' });
    const result = instr.concat(' suffix');
    expect(result.audio).toBe('audio suffix');
    expect(result.text).toBe('text suffix');
  });

  it('concatInstructions handles string + Instructions (radd-style)', () => {
    const instr = new Instructions({ audio: 'audio', text: 'text' });
    const result = concatInstructions('prefix ', instr);
    expect(isInstructions(result)).toBe(true);
    if (!isInstructions(result)) return;
    expect(result.audio).toBe('prefix audio');
    expect(result.text).toBe('prefix text');
  });

  it('preserves text=undefined when concatenating an audio-only instructions', () => {
    const audioOnly = new Instructions({ audio: 'audio only' });
    const result = audioOnly.concat(' more');
    expect(result.toJSON()).toEqual({ type: 'instructions', audio: 'audio only more' });
    expect(result.audio).toBe('audio only more');
    expect(result.text).toBe('audio only more');
  });

  it('when only one side has a text variant, the other contributes its audio', () => {
    const a = new Instructions({ audio: 'audio A', text: 'text A' });
    const b = new Instructions({ audio: 'audio B' });
    const result = concatInstructions(a, ' ', b);
    expect(isInstructions(result)).toBe(true);
    if (!isInstructions(result)) return;
    expect(result.audio).toBe('audio A audio B');
    expect(result.text).toBe('text A audio B');
  });

  it('asModality returns a copy with both variants preserved', () => {
    const instr = new Instructions({ audio: 'audio instructions', text: 'text instructions' });

    let resolved = instr.asModality('audio');
    expect(resolved.value).toBe('audio instructions');
    expect(resolved.audio).toBe('audio instructions');
    expect(resolved.text).toBe('text instructions');

    resolved = instr.asModality('text');
    expect(resolved.value).toBe('text instructions');
    expect(resolved.audio).toBe('audio instructions');
    expect(resolved.text).toBe('text instructions');
  });

  it('can switch modality after a previous resolution', () => {
    const instr = new Instructions({ audio: 'audio instructions', text: 'text instructions' });
    const resolvedText = instr.asModality('text');
    const resolvedAudio = resolvedText.asModality('audio');
    expect(resolvedAudio.value).toBe('audio instructions');
  });

  it('asModality on audio-only Instructions returns audio for both modalities', () => {
    const audioOnly = new Instructions({ audio: 'audio only' });
    expect(audioOnly.asModality('audio').value).toBe('audio only');
    expect(audioOnly.asModality('text').value).toBe('audio only');
  });

  it('applyInstructionsModality rewrites the system message content', () => {
    const instr = new Instructions({ audio: 'audio instructions', text: 'text instructions' });
    const ctx = new ChatContext([
      ChatMessage.create({
        id: INSTRUCTIONS_MESSAGE_ID,
        role: 'system',
        content: [instr],
      }),
    ]);

    applyInstructionsModality(ctx, { modality: 'audio' });
    let content = (ctx.items[0]! as ChatMessage).content[0]!;
    expect(isInstructions(content) ? content.value : '').toBe('audio instructions');

    applyInstructionsModality(ctx, { modality: 'text' });
    content = (ctx.items[0]! as ChatMessage).content[0]!;
    expect(isInstructions(content) ? content.value : '').toBe('text instructions');
  });

  it('applyInstructionsModality is a no-op when content has no Instructions', () => {
    const ctx = new ChatContext([
      ChatMessage.create({
        id: INSTRUCTIONS_MESSAGE_ID,
        role: 'system',
        content: ['plain string instructions'],
      }),
    ]);
    const before = (ctx.items[0]! as ChatMessage).content[0];
    applyInstructionsModality(ctx, { modality: 'text' });
    expect((ctx.items[0]! as ChatMessage).content[0]).toBe(before);
  });

  it('survives copy and lets a different modality be applied to the copy', () => {
    const instr = new Instructions({ audio: 'audio instructions', text: 'text instructions' });
    const baseCtx = new ChatContext([
      ChatMessage.create({
        id: INSTRUCTIONS_MESSAGE_ID,
        role: 'system',
        content: [instr],
      }),
    ]);
    const turn1 = baseCtx.copy();
    applyInstructionsModality(turn1, { modality: 'text' });
    const turn2 = turn1.copy();
    applyInstructionsModality(turn2, { modality: 'audio' });

    const turn2Content = (turn2.items[0]! as ChatMessage).content[0]!;
    expect(isInstructions(turn2Content) ? turn2Content.value : '').toBe('audio instructions');

    // base context content is untouched (was the original instr)
    expect((baseCtx.items[0]! as ChatMessage).content[0]).toBe(instr);
  });
});

describe('ChatContext.copy with toolCtx filter', () => {
  it('drops function calls / outputs whose tool is not in the supplied ToolContext', () => {
    const known = tool({ name: 'known', description: 'k', execute: async () => 'ok' });
    const ctx = new ChatContext([
      ChatMessage.create({ role: 'user', content: ['hello'] }),
      FunctionCall.create({ callId: 'c1', name: 'known', args: '{}' }),
      FunctionCallOutput.create({ callId: 'c1', name: 'known', output: 'done', isError: false }),
      FunctionCall.create({ callId: 'c2', name: 'removed', args: '{}' }),
      FunctionCallOutput.create({ callId: 'c2', name: 'removed', output: 'x', isError: false }),
    ]);

    const filtered = ctx.copy({ toolCtx: new ToolContext([known]) });
    const types = filtered.items.map((i) => `${i.type}:${'name' in i ? i.name : ''}`);
    expect(types).toEqual(['message:', 'function_call:known', 'function_call_output:known']);
  });

  it('keeps provider-tool calls when the ToolContext holds a matching provider tool id', () => {
    class CodeRunner extends ProviderTool {}
    const provider = new CodeRunner({ id: 'code_runner' });
    const ctx = new ChatContext([
      FunctionCall.create({ callId: 'p1', name: 'code_runner', args: '{}' }),
      FunctionCall.create({ callId: 'p2', name: 'other', args: '{}' }),
    ]);

    const filtered = ctx.copy({ toolCtx: new ToolContext([provider]) });
    expect(filtered.items.map((i) => ('name' in i ? i.name : ''))).toEqual(['code_runner']);
  });
});
