// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, ChatContext, type llm } from '@livekit/agents';
import { llm as llmTest } from '@livekit/agents-plugins-test';
import type { Mistral } from '@mistralai/mistralai';
import type { ConversationEvents } from '@mistralai/mistralai/models/components';
import { HTTPValidationError, SDKError } from '@mistralai/mistralai/models/errors';
import { describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';

function sdkError(statusCode: number): SDKError {
  const body = '{"message":"provider error"}';
  const request = new Request('https://api.mistral.ai/v1/conversations', { method: 'POST' });
  const response = new Response(body, {
    status: statusCode,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
  });
  return new SDKError('provider error', { request, response, body });
}

function validationError(): HTTPValidationError {
  const body = '{"detail":[{"msg":"invalid request"}]}';
  const request = new Request('https://api.mistral.ai/v1/conversations', { method: 'POST' });
  const response = new Response(body, {
    status: 422,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_validation' },
  });
  return new HTTPValidationError({}, { request, response, body });
}

function modelWithResponses(responses: Array<AsyncIterable<ConversationEvents> | Error>): {
  model: LLM;
  startStream: ReturnType<typeof vi.fn>;
} {
  const startStream = vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error('missing fake response');
    return response;
  });
  const client = { beta: { conversations: { startStream } } } as unknown as Mistral;
  return { model: new LLM({ client, model: 'test-model' }), startStream };
}

async function consume(model: LLM): Promise<{ chunks: llm.ChatChunk[]; errors: llm.LLMError[] }> {
  const errors: llm.LLMError[] = [];
  model.on('error', (error) => errors.push(error));
  const chunks: llm.ChatChunk[] = [];
  try {
    const stream = model.chat({
      chatCtx: ChatContext.empty(),
      connOptions: { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    for await (const chunk of stream) chunks.push(chunk);
    return { chunks, errors };
  } finally {
    await model.aclose();
  }
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

describe('Mistral LLM error handling', () => {
  it('does not retry a client error', async () => {
    const { model, startStream } = modelWithResponses([sdkError(400)]);

    const { errors } = await consume(model);

    expect(startStream).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    const error = errors[0]!.error;
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({
      statusCode: 400,
      requestId: 'req_test',
      body: '{"message":"provider error"}',
      retryable: false,
    });
    expect(errors[0]!.recoverable).toBe(false);
  });

  it('does not retry a validation error', async () => {
    const { model, startStream } = modelWithResponses([validationError()]);

    const { errors } = await consume(model);

    expect(startStream).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toMatchObject({
      statusCode: 422,
      requestId: 'req_validation',
      body: '{"detail":[{"msg":"invalid request"}]}',
      retryable: false,
    });
  });

  it('does not retry a status error after output', async () => {
    async function* events(): AsyncIterable<ConversationEvents> {
      yield {
        data: {
          type: 'message.output.delta',
          outputIndex: 0,
          id: 'msg_1',
          contentIndex: 0,
          role: 'assistant',
          content: 'partial',
        },
      };
      throw sdkError(500);
    }
    const { model, startStream } = modelWithResponses([events()]);

    const { chunks, errors } = await consume(model);

    expect(chunks.map((chunk) => chunk.delta?.content).filter(Boolean)).toEqual(['partial']);
    expect(startStream).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toMatchObject({ statusCode: 500, retryable: false });
    expect(errors[0]!.recoverable).toBe(false);
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
