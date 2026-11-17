// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ChatContext, ConnectionPool } from '@livekit/agents';
import type { llm } from '@livekit/agents';
import { EventEmitter, once } from 'node:events';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { WebSearch } from '../tools.js';
import { ResponsesWebSocket, WSLLM, WSLLMStream } from '../ws/llm.js';
import { LLM } from './llm.js';

async function replay(transport: 'http' | 'websocket', events: unknown[], failAfter = false) {
  const requests: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const chatCtx = ChatContext.empty();
  chatCtx.addMessage({ role: 'user', content: 'Find sources.' });
  const options = { include: ['web_search_call.action.sources'] };
  const connOptions = { maxRetry: failAfter ? 1 : 0, retryIntervalMs: 0, timeoutMs: 1000 };
  let model: LLM | WSLLM;
  let response: llm.LLMStream;
  let pool: ConnectionPool<ResponsesWebSocket> | undefined;
  if (transport === 'http') {
    const client = new OpenAI({
      apiKey: 'offline-test-key',
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        let index = 0;
        const body = failAfter
          ? new ReadableStream<Uint8Array>({
              pull(controller) {
                if (index < events.length) {
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(events[index++])}\n\n`),
                  );
                } else {
                  controller.error(new Error('connection lost'));
                }
              },
            })
          : events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    model = new LLM({ client, useWebSocket: false });
    response = model.chat({
      chatCtx,
      toolCtx: [new WebSearch()],
      extraKwargs: options,
      connOptions,
    });
  } else {
    class ReplaySocket extends EventEmitter {
      readyState = 1;
      send(data: string): void {
        requests.push(JSON.parse(data));
        queueMicrotask(() => {
          for (const event of events) this.emit('message', Buffer.from(JSON.stringify(event)));
          if (failAfter)
            this.emit(
              'message',
              Buffer.from(JSON.stringify({ type: 'error', code: 'websocket_closed' })),
            );
        });
      }
      close(): void {}
    }
    const connection = new ResponsesWebSocket(new ReplaySocket() as never);
    pool = new ConnectionPool({ connectCb: async () => connection });
    model = new WSLLM({ apiKey: 'offline-test-key' });
    response = new WSLLMStream(model, {
      pool,
      model: 'gpt-5.6',
      chatCtx,
      fullChatCtx: chatCtx,
      connOptions,
      toolCtx: undefined,
      modelOptions: options,
      strictToolSchema: true,
    });
  }
  model.on('error', (error) => errors.push(error));
  try {
    return { result: await response.collect(), requests, errors };
  } finally {
    await pool?.close();
    await model.aclose();
  }
}

const citation = {
  type: 'url_citation',
  start_index: 0,
  end_index: 5,
  title: 'Example',
  url: 'https://example.com/source',
};
const message = {
  id: 'msg_first',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Hello', annotations: [citation] }],
};
const finalMessage = { ...message, id: 'msg_second', phase: 'final_answer' };
const usage = {
  input_tokens: 10,
  output_tokens: 2,
  total_tokens: 12,
  input_tokens_details: { cached_tokens: 0 },
};

describe.each(['http', 'websocket'] as const)('%s Responses search metadata', (transport) => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'preserves search output, citations and phase (sources=%s, usage=%s)',
    async (sources, withUsage) => {
      const search = {
        id: 'ws_first',
        type: 'web_search_call',
        status: 'completed',
        action: {
          type: 'search',
          query: 'example',
          ...(sources ? { sources: [{ type: 'url', url: citation.url }] } : {}),
        },
      };
      const secondSearch = { ...search, id: 'ws_second' };
      const events = [
        { type: 'response.created', response: { id: 'resp_test' } },
        { type: 'response.output_item.done', item: search },
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_item.done', item: message },
        { type: 'response.output_item.done', item: secondSearch },
        { type: 'response.output_item.done', item: finalMessage },
        {
          type: 'response.completed',
          response: {
            id: 'resp_test',
            output: [search, message, secondSearch, finalMessage],
            ...(withUsage ? { usage } : {}),
          },
        },
      ];
      const { result, requests, errors } = await replay(transport, events);
      expect(errors).toEqual([]);
      expect(requests[0]?.include).toEqual(['web_search_call.action.sources']);
      expect(result.text).toBe('Hello');
      expect(result.toolCalls).toEqual([]);
      expect(result.extra).toEqual({
        openai: {
          phase: 'final_answer',
          output: [search, message, secondSearch, finalMessage],
        },
      });
      expect(result.usage?.totalTokens).toBe(withUsage ? 12 : undefined);
    },
  );

  it.each([undefined, null])('preserves annotated messages with phase %s', async (phase) => {
    const annotated = { ...message, ...(phase === undefined ? {} : { phase }) };
    const { result, errors } = await replay(transport, [
      { type: 'response.created', response: { id: 'resp_no_phase' } },
      { type: 'response.output_item.done', item: annotated },
      { type: 'response.completed', response: { id: 'resp_no_phase' } },
    ]);
    expect(errors).toEqual([]);
    expect(result.extra).toEqual({
      openai: {
        ...(phase === undefined ? {} : { phase }),
        output: [annotated],
      },
    });
  });

  it('does not retry after search results have reached the application', async () => {
    const search = {
      id: 'ws_visible',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: 'example' },
    };
    const { result, requests, errors } = await replay(
      transport,
      [
        { type: 'response.created', response: { id: 'resp_failed' } },
        { type: 'response.output_item.done', item: search },
      ],
      true,
    );
    expect(requests).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(result.extra).toEqual({ openai: { output: [search] } });
  });

  it('keeps ordinary text and phase-only metadata unchanged', async () => {
    const { result, errors } = await replay(transport, [
      { type: 'response.created', response: { id: 'resp_plain' } },
      { type: 'response.output_text.delta', delta: 'Hello' },
      {
        type: 'response.output_item.done',
        item: {
          ...finalMessage,
          content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
        },
      },
      { type: 'response.completed', response: { id: 'resp_plain', usage } },
    ]);
    expect(errors).toEqual([]);
    expect(result.text).toBe('Hello');
    expect(result.extra).toEqual({ openai: { phase: 'final_answer' } });
  });
});

describe.each(['http', 'websocket'] as const)('%s Responses include option', (transport) => {
  it.each([undefined, []])(
    'forwards constructor includes and honors per-call override %s',
    async (override) => {
      let request: Record<string, unknown> | undefined;
      const events = [
        { type: 'response.created', response: { id: 'resp_options' } },
        { type: 'response.completed', response: { id: 'resp_options' } },
      ];
      const server =
        transport === 'websocket' ? new WebSocketServer({ host: '127.0.0.1', port: 0 }) : undefined;
      let baseURL: string | undefined;
      if (server) {
        await once(server, 'listening');
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('expected TCP address');
        baseURL = `http://127.0.0.1:${address.port}/v1`;
        server.on('connection', (socket) =>
          socket.on('message', (data) => {
            request = JSON.parse(String(data));
            for (const event of events) socket.send(JSON.stringify(event));
          }),
        );
      }
      const client = server
        ? undefined
        : new OpenAI({
            apiKey: 'offline-test-key',
            fetch: async (_url, init) => {
              request = JSON.parse(String(init?.body));
              return new Response(
                events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
                {
                  headers: { 'content-type': 'text/event-stream' },
                },
              );
            },
          });
      const model = new LLM({
        apiKey: 'offline-test-key',
        client,
        baseURL,
        useWebSocket: transport === 'websocket',
        include: ['web_search_call.action.sources'],
      });
      const errors: unknown[] = [];
      model.on('error', (error) => errors.push(error));
      const chatCtx = ChatContext.empty();
      chatCtx.addMessage({ role: 'user', content: 'Find sources.' });
      try {
        await model
          .chat({ chatCtx, extraKwargs: override ? { include: override } : undefined })
          .collect();
        expect(errors).toEqual([]);
        expect(request?.include).toEqual(override ?? ['web_search_call.action.sources']);
      } finally {
        await model.aclose();
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
