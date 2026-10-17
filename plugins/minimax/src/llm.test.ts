// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { AnthropicLLM, type AnthropicLLMOptions, LLM, type LLMOptions } from './llm.js';
import {
  CHAT_MODEL_INFO,
  type ChatThinkingMode,
  DEFAULT_CHAT_MODEL,
  REGIONAL_ENDPOINTS,
} from './models.js';

const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const chunk of stream) {
    void chunk;
  }
};

describe('MiniMax LLM', () => {
  it('exports the current model metadata', () => {
    expect(DEFAULT_CHAT_MODEL).toBe('MiniMax-M3');
    expect(CHAT_MODEL_INFO).toEqual({
      'MiniMax-M3': {
        contextWindow: 1_000_000,
        pricingUSDPerMillionTokens: {
          input: 0.6,
          output: 2.4,
          cacheRead: 0.12,
          cacheWrite: null,
        },
        inputModalities: ['text', 'image', 'video'],
        thinking: ['adaptive', 'disabled'],
      },
      'MiniMax-M2.7': {
        contextWindow: 204_800,
        pricingUSDPerMillionTokens: {
          input: 0.3,
          output: 1.2,
          cacheRead: 0.06,
          cacheWrite: 0.375,
        },
        inputModalities: ['text'],
        thinking: ['always_on'],
      },
    });
  });

  it('selects global and China compatible endpoints', () => {
    const globalOpenAI = new LLM({ apiKey: 'test-key' });
    const chinaOpenAI = new LLM({ apiKey: 'test-key', region: 'cn_zh' });
    const globalAnthropic = new AnthropicLLM({ apiKey: 'test-key' });
    const chinaAnthropic = new AnthropicLLM({ apiKey: 'test-key', region: 'cn_zh' });

    expect(globalOpenAI.baseURL).toBe(REGIONAL_ENDPOINTS.global_en.openAIBaseURL);
    expect(chinaOpenAI.baseURL).toBe(REGIONAL_ENDPOINTS.cn_zh.openAIBaseURL);
    expect(globalAnthropic.baseURL).toBe(REGIONAL_ENDPOINTS.global_en.anthropicBaseURL);
    expect(chinaAnthropic.baseURL).toBe(REGIONAL_ENDPOINTS.cn_zh.anthropicBaseURL);
  });

  it('passes adaptive thinking to the OpenAI-compatible request', async () => {
    let capturedRequest: Record<string, unknown> | undefined;
    const client = {
      baseURL: 'https://unused.invalid',
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            capturedRequest = request;
            return (async function* (): AsyncGenerator<never> {})();
          },
        },
      },
    } as unknown as NonNullable<LLMOptions['client']>;
    const model = new LLM({ client, thinking: 'adaptive' });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hello' });

    await drain(model.chat({ chatCtx }));

    expect(capturedRequest?.thinking).toEqual({ type: 'adaptive' });
  });

  it('passes disabled thinking to the Anthropic-compatible request', async () => {
    let capturedRequest: Record<string, unknown> | undefined;
    const client = {
      baseURL: 'https://unused.invalid',
      messages: {
        create: async (request: Record<string, unknown>) => {
          capturedRequest = request;
          return (async function* (): AsyncGenerator<never> {})();
        },
      },
    } as unknown as NonNullable<AnthropicLLMOptions['client']>;
    const model = new AnthropicLLM({ client, thinking: 'disabled' });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hello' });

    await drain(model.chat({ chatCtx }));

    expect(capturedRequest?.thinking).toEqual({ type: 'disabled' });
  });

  it('keeps always-on thinking implicit for MiniMax-M2.7', async () => {
    let capturedRequest: Record<string, unknown> | undefined;
    const client = {
      baseURL: 'https://unused.invalid',
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            capturedRequest = request;
            return (async function* (): AsyncGenerator<never> {})();
          },
        },
      },
    } as unknown as NonNullable<LLMOptions['client']>;
    const model = new LLM({ client, model: 'MiniMax-M2.7' });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hello' });

    await drain(model.chat({ chatCtx }));

    expect(model.thinking).toBe('always_on');
    expect(capturedRequest).not.toHaveProperty('thinking');
  });

  it.each<ChatThinkingMode>(['adaptive', 'disabled'])(
    'rejects %s thinking for MiniMax-M2.7',
    (thinking) => {
      expect(() => new LLM({ apiKey: 'test-key', model: 'MiniMax-M2.7', thinking })).toThrow(
        `Thinking mode "${thinking}" is not supported by MiniMax model "MiniMax-M2.7"`,
      );
    },
  );

  it('rejects always-on thinking for MiniMax-M3', () => {
    expect(
      () => new LLM({ apiKey: 'test-key', model: 'MiniMax-M3', thinking: 'always_on' }),
    ).toThrow('Thinking mode "always_on" is not supported by MiniMax model "MiniMax-M3"');
  });
});
