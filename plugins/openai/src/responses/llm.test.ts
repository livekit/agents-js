// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, ChatContext, initializeLogger } from '@livekit/agents';
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { wsServerEventSchema } from '../ws/types.js';
import { LLM } from './llm.js';

initializeLogger({ level: 'silent', pretty: false });

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

describe('OpenAI Responses WebSocket', () => {
  it('preserves top-level code and param on error frames', () => {
    const frame = {
      type: 'error',
      message:
        "Invalid type for 'reasoning.mode': expected one of 'standard' or 'pro', but got null instead.",
      code: 'invalid_type',
      param: 'reasoning.mode',
      status: 400,
    };

    const parsed = wsServerEventSchema.parse(frame);

    expect(parsed.type).toBe('error');
    if (parsed.type !== 'error') throw new Error('expected error event');
    expect(parsed.message).toBe(frame.message);
    expect(parsed.param).toBe('reasoning.mode');
  });
});

type ResponsesEvent = Record<string, unknown>;

// opens every stream, on every provider
const RESPONSE_CREATED: ResponsesEvent = {
  type: 'response.created',
  response: { id: 'resp_1' },
};

// a reasoning phase marker: a message item with no text of its own
const PHASE_METADATA: ResponsesEvent = {
  type: 'response.output_item.done',
  item: { type: 'message', phase: 'thinking' },
};

const TEXT_DELTA: ResponsesEvent = {
  type: 'response.output_text.delta',
  delta: 'hello',
};

/**
 * Replays the given events, then dies the way a provider going quiet does.
 * Returns how many times the request was attempted.
 */
async function attemptsUntilStall(events: ResponsesEvent[], maxRetry: number): Promise<number> {
  let attempts = 0;

  const client = {
    responses: {
      create: async () => {
        attempts++;
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of events) {
              yield event;
            }
            throw new Error('stalled mid-stream');
          },
        };
      },
    },
  };

  const model = new LLM({
    model: 'gpt-4.1',
    apiKey: 'test-key',
    useWebSocket: false,
    client: client as unknown as OpenAI,
  });
  // the stream emits 'error' on every failed attempt; without a listener the
  // EventEmitter turns it into an unhandled error and fails the run
  model.on('error', () => {});

  const chatCtx = ChatContext.empty();
  chatCtx.addMessage({ role: 'user', content: 'hi' });

  try {
    const stream = model.chat({
      chatCtx,
      connOptions: { maxRetry, retryIntervalMs: 0, timeoutMs: 5000 },
    });
    for await (const _chunk of stream) {
      void _chunk;
    }
  } catch {
    // the stall surfaces through the 'error' event; the iterator just ends
  }

  return attempts;
}

describe('OpenAI Responses HTTP retry eligibility', () => {
  it('retries a stall that follows the stream-opening event alone', async () => {
    expect(await attemptsUntilStall([RESPONSE_CREATED], 2)).toBe(3);
  });

  it('retries a stall that follows a phase marker', async () => {
    expect(await attemptsUntilStall([RESPONSE_CREATED, PHASE_METADATA], 2)).toBe(3);
  });

  it('does not retry once generated text has reached the caller', async () => {
    expect(await attemptsUntilStall([RESPONSE_CREATED, TEXT_DELTA], 2)).toBe(1);
  });
});

describe('OpenAI Responses HTTP incomplete handling', () => {
  it.each([
    ['max_output_tokens', 'max_output_tokens'],
    [undefined, 'reason unavailable'],
  ] as const)('surfaces %s as non-retryable', async (reason, expectedMessage) => {
    let attempts = 0;
    const incomplete = {
      type: 'response.incomplete',
      response: {
        id: 'resp_1',
        ...(reason === undefined ? {} : { incomplete_details: { reason } }),
      },
    };
    const client = {
      responses: {
        create: async () => {
          attempts++;
          return {
            async *[Symbol.asyncIterator]() {
              yield RESPONSE_CREATED;
              yield incomplete;
            },
          };
        },
      },
    };
    const model = new LLM({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      useWebSocket: false,
      client: client as unknown as OpenAI,
    });
    const errorEvent = new Promise<Error>((resolve) => {
      model.once('error', (event) => resolve(event.error));
    });
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'hi' });

    const stream = model.chat({
      chatCtx,
      connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 5000 },
    });
    for await (const _chunk of stream) void _chunk;
    const error = await errorEvent;

    expect(error).toBeInstanceOf(APIStatusError);
    expect(error.message).toContain(expectedMessage);
    expect((error as APIStatusError).statusCode).toBe(-1);
    expect((error as APIStatusError).retryable).toBe(false);
    expect(attempts).toBe(1);
    await model.aclose();
  });
});

if (hasOpenAIApiKey) {
  describe('OpenAI Responses', async () => {
    await llm(
      new LLM({
        temperature: 0,
        strictToolSchema: false,
      }),
      true,
    );
  });
} else {
  describe('OpenAI Responses', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}

if (hasOpenAIApiKey) {
  describe('OpenAI Responses strict tool schema', async () => {
    await llmStrict(
      new LLM({
        temperature: 0,
        strictToolSchema: true,
      }),
    );
  });
} else {
  describe('OpenAI Responses strict tool schema', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}

describe('OpenAI Responses HTTP usage', () => {
  async function usageFor(usage: Record<string, unknown>) {
    const completed = {
      type: 'response.completed',
      response: { id: 'resp_1', usage },
    };
    const client = {
      responses: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield RESPONSE_CREATED;
            yield completed;
          },
        }),
      },
    };
    const model = new LLM({
      model: 'gpt-5',
      apiKey: 'test-key',
      useWebSocket: false,
      client: client as unknown as OpenAI,
    });

    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'hi' });
    const stream = model.chat({
      chatCtx,
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 5000 },
    });
    for await (const chunk of stream) {
      if (chunk.usage) return chunk.usage;
    }
    return undefined;
  }

  it('reports reasoning tokens', async () => {
    const usage = await usageFor({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 80,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 180,
    });

    expect(usage).toMatchObject({
      promptTokens: 100,
      promptCachedTokens: 40,
      completionTokens: 80,
      reasoningTokens: 30,
      totalTokens: 180,
    });
  });

  it('accepts usage without the token detail blocks', async () => {
    const usage = await usageFor({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });

    expect(usage).toMatchObject({
      promptTokens: 10,
      promptCachedTokens: 0,
      completionTokens: 5,
      totalTokens: 15,
    });
  });
});
