// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { AnthropicLLM, type AnthropicLLMOptions, LLM, type LLMOptions } from './llm.js';
import { CHAT_MODEL_INFO, DEFAULT_CHAT_MODEL, REGIONAL_ENDPOINTS } from './models.js';

const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const chunk of stream) {
    void chunk;
  }
};

describe('MiniMax LLM', () => {
  it('exports the current model metadata', () => {
    expect(DEFAULT_CHAT_MODEL).toBe('MiniMax-M3.1-Flash');
    expect(CHAT_MODEL_INFO).toEqual({
      'MiniMax-M3.1-Flash': {
        contextWindow: 1_000_000,
        pricingUSDPerMillionTokens: {
          input: 0.15,
          output: 0.6,
          cacheRead: 0.015,
          cacheWrite: null,
        },
        pricingTiers: null,
        inputModalities: ['text', 'image', 'video'],
        thinking: ['adaptive'],
        thinkingAlwaysOn: true,
        thinkingDefaults: {
          openAI: 'adaptive',
          anthropic: 'adaptive',
        },
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        reasoningEffortDefault: 'max',
        serviceTierSupported: false,
      },
      'MiniMax-M3': {
        contextWindow: 1_000_000,
        pricingUSDPerMillionTokens: {
          input: 0.3,
          output: 1.2,
          cacheRead: 0.06,
          cacheWrite: null,
        },
        pricingTiers: {
          selectionBasis: 'request_input_tokens',
          inputTokenThreshold: '512k',
          standard: [
            {
              inputTokenCondition: '<=512k',
              pricingUSDPerMillionTokens: {
                input: 0.3,
                output: 1.2,
                cacheRead: 0.06,
                cacheWrite: null,
              },
            },
            {
              inputTokenCondition: '>512k',
              pricingUSDPerMillionTokens: {
                input: 0.6,
                output: 2.4,
                cacheRead: 0.12,
                cacheWrite: null,
              },
            },
          ],
          priorityMultiplier: 1.5,
          priorityMultiplierAppliesTo: ['input', 'output', 'cacheRead'],
        },
        inputModalities: ['text', 'image', 'video'],
        thinking: ['adaptive', 'disabled'],
        thinkingAlwaysOn: false,
        thinkingDefaults: {
          openAI: 'adaptive',
          anthropic: 'disabled',
        },
        reasoningEfforts: [],
        reasoningEffortDefault: null,
        serviceTierSupported: true,
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

  it('passes default MiniMax-M3.1-Flash options to the OpenAI-compatible request', async () => {
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
    const model = new LLM({ client });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hello' });

    await drain(model.chat({ chatCtx }));

    expect(model.thinking).toBe('adaptive');
    expect(model.reasoningEffort).toBe('max');
    expect(capturedRequest?.thinking).toEqual({ type: 'adaptive' });
    expect(capturedRequest?.reasoning_effort).toBe('max');
  });

  it('passes default MiniMax-M3.1-Flash options to the Anthropic-compatible request', async () => {
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
    const model = new AnthropicLLM({ client });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hello' });

    await drain(model.chat({ chatCtx }));

    expect(model.thinking).toBe('adaptive');
    expect(model.reasoningEffort).toBe('max');
    expect(capturedRequest?.thinking).toEqual({ type: 'adaptive' });
    expect(capturedRequest?.output_config).toEqual({ effort: 'max' });
  });

  it('uses API-specific MiniMax-M3 thinking defaults and ignores effort', async () => {
    let openAIRequest: Record<string, unknown> | undefined;
    let anthropicRequest: Record<string, unknown> | undefined;
    const openAIClient = {
      baseURL: 'https://unused.invalid',
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            openAIRequest = request;
            return (async function* (): AsyncGenerator<never> {})();
          },
        },
      },
    } as unknown as NonNullable<LLMOptions['client']>;
    const anthropicClient = {
      baseURL: 'https://unused.invalid',
      messages: {
        create: async (request: Record<string, unknown>) => {
          anthropicRequest = request;
          return (async function* (): AsyncGenerator<never> {})();
        },
      },
    } as unknown as NonNullable<AnthropicLLMOptions['client']>;
    const openAIModel = new LLM({
      client: openAIClient,
      model: 'MiniMax-M3',
      reasoningEffort: 'high',
    });
    const anthropicModel = new AnthropicLLM({
      client: anthropicClient,
      model: 'MiniMax-M3',
      reasoningEffort: 'high',
    });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hello' });

    await drain(openAIModel.chat({ chatCtx }));
    await drain(anthropicModel.chat({ chatCtx }));

    expect(openAIModel.thinking).toBe('adaptive');
    expect(anthropicModel.thinking).toBe('disabled');
    expect(openAIModel.reasoningEffort).toBeUndefined();
    expect(anthropicModel.reasoningEffort).toBeUndefined();
    expect(openAIRequest?.thinking).toEqual({ type: 'adaptive' });
    expect(openAIRequest).not.toHaveProperty('reasoning_effort');
    expect(anthropicRequest?.thinking).toEqual({ type: 'disabled' });
    expect(anthropicRequest).not.toHaveProperty('output_config');
  });

  it('rejects disabled thinking for MiniMax-M3.1-Flash', () => {
    expect(() => new LLM({ apiKey: 'test-key', thinking: 'disabled' })).toThrow(
      'Thinking mode "disabled" is not supported by MiniMax model "MiniMax-M3.1-Flash"',
    );
  });
});
