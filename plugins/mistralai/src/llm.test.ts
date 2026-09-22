// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, llm } from '@livekit/agents';
import { llm as llmTest } from '@livekit/agents-plugins-test';
import type { Mistral } from '@mistralai/mistralai';
import { SDKError } from '@mistralai/mistralai/models/errors';
import { describe, expect, it, vi } from 'vitest';
import { ApiMode, LLM } from './llm.js';
import { WebSearch } from './tools.js';

const connOptions = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 };

function completionEvent({
  id = 'cmpl_1',
  content,
  toolCalls,
  finishReason = null,
  usage,
}: {
  id?: string;
  content?: unknown;
  toolCalls?: unknown;
  finishReason?: string | null;
  usage?: unknown;
} = {}) {
  return {
    data: {
      id,
      model: 'test-model',
      choices: [{ index: 0, delta: { content, toolCalls }, finishReason }],
      usage,
    },
  };
}

function mistralError(statusCode: number, message = 'error'): SDKError {
  const request = new Request('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
  });
  const response = new Response(message, { status: statusCode });
  return new SDKError(message, { request, response, body: message });
}

function fakeModel({
  apiMode = ApiMode.CONVERSATIONS,
  chatEvents,
  conversationEvents,
}: {
  apiMode?: ApiMode;
  chatEvents?: (call: number) => AsyncIterable<unknown> | Error;
  conversationEvents?: (call: number) => AsyncIterable<unknown> | Error;
} = {}) {
  let chatCalls = 0;
  let conversationCalls = 0;
  const chatStream = vi.fn(async () => {
    chatCalls += 1;
    const result = chatEvents?.(chatCalls) ?? (async function* () {})();
    if (result instanceof Error) throw result;
    return result;
  });
  const startStream = vi.fn(async () => {
    conversationCalls += 1;
    const result = conversationEvents?.(conversationCalls) ?? (async function* () {})();
    if (result instanceof Error) throw result;
    return result;
  });
  const client = {
    chat: { stream: chatStream },
    beta: { conversations: { startStream } },
  } as unknown as Mistral;

  return {
    model: new LLM({ client, model: 'test-model', apiMode }),
    chatStream,
    startStream,
  };
}

async function collect(stream: AsyncIterable<llm.ChatChunk>): Promise<llm.ChatChunk[]> {
  const chunks: llm.ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('Mistral LLM prewarm', () => {
  it('lists models with the prewarm cancellation signal', async () => {
    let prewarmSignal: AbortSignal | undefined;
    const modelsList = vi.fn(async (_request: undefined, options: { signal?: AbortSignal }) => {
      prewarmSignal = options.signal;
    });
    const client = {
      models: { list: modelsList },
    } as unknown as Mistral;
    const llm = new LLM({ client });

    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(modelsList).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(prewarmSignal?.aborted).toBe(false);

    await llm.aclose();
    expect(prewarmSignal?.aborted).toBe(true);
  });
});

describe('Mistral LLM chat completions mode', () => {
  it('streams text', async () => {
    const { model, chatStream } = fakeModel({
      apiMode: ApiMode.CHAT_COMPLETIONS,
      chatEvents: () =>
        (async function* () {
          yield completionEvent({ content: 'Hello' });
          yield completionEvent({ content: ' world' });
        })(),
    });

    const chunks = await collect(model.chat({ chatCtx: llm.ChatContext.empty(), connOptions }));

    expect(chunks.flatMap((chunk) => chunk.delta?.content ?? [])).toEqual(['Hello', ' world']);
    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it('accumulates streamed tool calls', async () => {
    const { model } = fakeModel({
      apiMode: ApiMode.CHAT_COMPLETIONS,
      chatEvents: () =>
        (async function* () {
          yield completionEvent({
            toolCalls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'get_weather', arguments: '{"loc' },
              },
            ],
          });
          yield completionEvent({
            toolCalls: [
              {
                index: 0,
                function: { name: '', arguments: 'ation": "paris"}' },
              },
            ],
            finishReason: 'tool_calls',
          });
        })(),
    });

    const chunks = await collect(model.chat({ chatCtx: llm.ChatContext.empty(), connOptions }));
    const toolCalls = chunks.flatMap((chunk) => chunk.delta?.toolCalls ?? []);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      name: 'get_weather',
      args: '{"location": "paris"}',
      callId: 'call_1',
    });
  });

  it('reports usage', async () => {
    const { model } = fakeModel({
      apiMode: ApiMode.CHAT_COMPLETIONS,
      chatEvents: () =>
        (async function* () {
          yield completionEvent({
            content: 'hi',
            usage: { completionTokens: 10, promptTokens: 5, totalTokens: 15 },
          });
        })(),
    });

    const chunks = await collect(model.chat({ chatCtx: llm.ChatContext.empty(), connOptions }));

    expect(chunks.find((chunk) => chunk.usage)?.usage).toMatchObject({
      completionTokens: 10,
      promptTokens: 5,
      totalTokens: 15,
    });
  });

  it('uses conversations mode by default', async () => {
    const { model, chatStream, startStream } = fakeModel({
      conversationEvents: () =>
        (async function* () {
          yield {
            data: { type: 'message.output.delta', id: 'msg_1', content: 'ok' },
          };
        })(),
    });

    await collect(model.chat({ chatCtx: llm.ChatContext.empty(), connOptions }));

    expect(startStream).toHaveBeenCalledTimes(1);
    expect(chatStream).not.toHaveBeenCalled();
  });

  it('maps Mistral errors', async () => {
    const { model } = fakeModel({
      apiMode: ApiMode.CHAT_COMPLETIONS,
      chatEvents: () => mistralError(503, 'overloaded'),
    });
    const errorEvent = new Promise<Error>((resolve) => {
      model.once('error', (event) => resolve(event.error));
    });

    await collect(model.chat({ chatCtx: llm.ChatContext.empty(), connOptions }));
    const error = await errorEvent;

    expect(error).toMatchObject({ statusCode: 503 });
  });

  it('does not retry errors after output', async () => {
    const { model, chatStream } = fakeModel({
      apiMode: ApiMode.CHAT_COMPLETIONS,
      chatEvents: () =>
        (async function* () {
          yield completionEvent({ content: 'partial' });
          throw mistralError(500, 'server error');
        })(),
    });
    const chunks: llm.ChatChunk[] = [];
    const errorEvent = new Promise<Error>((resolve) => {
      model.once('error', (event) => resolve(event.error));
    });

    for await (const chunk of model.chat({
      chatCtx: llm.ChatContext.empty(),
      connOptions: { ...connOptions, maxRetry: 3 },
    })) {
      chunks.push(chunk);
    }
    const error = await errorEvent;

    expect(chunks.flatMap((chunk) => chunk.delta?.content ?? [])).toEqual(['partial']);
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).retryable).toBe(false);
  });

  it('rejects provider tools', async () => {
    const { model } = fakeModel({ apiMode: ApiMode.CHAT_COMPLETIONS });
    const errorEvent = new Promise<Error>((resolve) => {
      model.once('error', (event) => resolve(event.error));
    });

    await collect(
      model.chat({
        chatCtx: llm.ChatContext.empty(),
        toolCtx: [new WebSearch()],
        connOptions,
      }),
    );
    const error = await errorEvent;

    expect(error.message).toContain('Provider tools');
  });
});

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

if (hasMistralApiKey) {
  describe('Mistral LLM', async () => {
    await llmTest(new LLM({ temperature: 0 }), false);
  });
} else {
  describe('Mistral LLM', () => {
    it.skip('requires MISTRAL_API_KEY', () => {});
  });
}
