// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { llmStrict, llm as testLLM } from '@livekit/agents-plugins-test';
import { type Socket, createServer } from 'node:net';
import { AzureOpenAI, default as OpenAI } from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';

// Some OpenAI-compatible proxies send a final chunk whose usage object is present but has null
// numeric fields. The SDK builds its usage model leniently, so those nulls reach our usage
// construction. See livekit/agents#6595.
const streamWithNullUsage = `data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"ok","role":"assistant"},"finish_reason":null,"index":0}],"created":0,"model":"m","object":"chat.completion.chunk"}

data: {"id":"chatcmpl-test","choices":[{"delta":{},"finish_reason":"stop","index":0}],"created":0,"model":"m","object":"chat.completion.chunk"}

data: {"id":"chatcmpl-test","choices":[],"created":0,"model":"m","object":"chat.completion.chunk","usage":{"completion_tokens":null,"prompt_tokens":7,"total_tokens":null}}

data: [DONE]

`;

describe('OpenAI LLM prewarm', () => {
  it('lists models with the prewarm cancellation signal', async () => {
    let prewarmSignal: AbortSignal | undefined;
    const modelsList = vi.fn(async (options: { signal?: AbortSignal }) => {
      prewarmSignal = options.signal;
    });
    const client = {
      baseURL: 'https://api.openai.test/v1',
      models: { list: modelsList },
    } as unknown as OpenAI;
    const llm = new LLM({ model: 'gpt-4.1', client });

    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(modelsList).toHaveBeenCalledTimes(1);
    expect(prewarmSignal).toBeInstanceOf(AbortSignal);
    expect(prewarmSignal?.aborted).toBe(false);

    await llm.aclose();
    expect(prewarmSignal?.aborted).toBe(true);
  });
});

it('withAzure keeps its connection between turns', async () => {
  const chatConnections = new Set();
  const modelConnections = new Set();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    socket.on('data', (data) => {
      pending = Buffer.concat([pending, data]);
      let headerEnd = pending.indexOf('\r\n\r\n');
      while (headerEnd !== -1) {
        const headers = pending.subarray(0, headerEnd).toString();
        const contentLength = Number(/\r\ncontent-length: (\d+)/i.exec(headers)?.[1] ?? 0);
        const requestEnd = headerEnd + 4 + contentLength;
        if (pending.length < requestEnd) break;
        pending = pending.subarray(requestEnd);
        const isChat = headers.startsWith('POST ') && headers.includes('/chat/completions');
        (isChat ? chatConnections : modelConnections).add(socket);
        const body = isChat
          ? 'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"ok","role":"assistant"},"finish_reason":"stop","index":0}],"created":0,"model":"gpt-4.1","object":"chat.completion.chunk"}\n\ndata: [DONE]\n\n'
          : JSON.stringify({ object: 'list', data: [] });
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: ${isChat ? 'text/event-stream' : 'application/json'}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        headerEnd = pending.indexOf('\r\n\r\n');
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a port');

  const model = LLM.withAzure({
    apiKey: 'k',
    apiVersion: '2025-04-01-preview',
    baseURL: `http://127.0.0.1:${address.port}/openai`,
    model: 'gpt-4.1',
  });
  const defaultClient = new AzureOpenAI({
    apiKey: 'k',
    apiVersion: '2025-04-01-preview',
    baseURL: `http://127.0.0.1:${address.port}/openai`,
  });
  const chatCtx = new llm.ChatContext();
  chatCtx.addMessage({ role: 'user', content: 'hi' });
  const chat = async () => {
    for await (const _chunk of model.chat({ chatCtx })) {
      // Consume the stream so the connection becomes idle again.
    }
  };

  try {
    await Promise.all([chat(), defaultClient.models.list()]);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await Promise.all([chat(), defaultClient.models.list()]);

    expect(chatConnections.size).toBe(1);
    expect(modelConnections.size).toBe(2);
  } finally {
    await model.aclose();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15_000);

it('does not crash the stream when usage token counts are null', async () => {
  // Null fields inside a non-null usage object must not terminate the stream. Missing counts
  // default to zero.
  const client = new OpenAI({
    apiKey: 'test-key',
    fetch: async () =>
      new Response(streamWithNullUsage, {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  const model = new LLM({ model: 'm', client });
  const chatCtx = new llm.ChatContext();
  chatCtx.addMessage({ role: 'user', content: 'hi' });

  const usageChunks: llm.CompletionUsage[] = [];
  const stream = model.chat({ chatCtx });
  try {
    for await (const chunk of stream) {
      if (chunk.usage) {
        usageChunks.push(chunk.usage);
      }
    }
  } finally {
    await model.aclose();
  }

  expect(usageChunks).toHaveLength(1);
  expect(usageChunks[0]?.completionTokens).toBe(0);
  expect(usageChunks[0]?.promptTokens).toBe(7);
  expect(usageChunks[0]?.totalTokens).toBe(0);
});

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

if (hasOpenAIApiKey) {
  describe('OpenAI', async () => {
    await testLLM(
      new LLM({
        temperature: 0,
      }),
      false,
    );
  });
} else {
  describe('OpenAI', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}

if (hasOpenAIApiKey) {
  describe('OpenAI strict tool schema', async () => {
    await llmStrict(
      new LLM({
        temperature: 0,
        strictToolSchema: true,
      }),
    );
  });
} else {
  describe('OpenAI strict tool schema', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
