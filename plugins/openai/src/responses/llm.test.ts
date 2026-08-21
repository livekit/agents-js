// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ChatContext, initializeLogger } from '@livekit/agents';
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
