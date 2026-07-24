// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, APIConnectionError, llm as agentsLLM } from '@livekit/agents';
import { llmStrict, llm as pluginLLM } from '@livekit/agents-plugins-test';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { ResponsesWebSocket, WSLLM, WS_HEARTBEAT } from '../ws/llm.js';
import { wsServerEventSchema } from '../ws/types.js';
import { LLM } from './llm.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

async function startResponsesServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));

  const address = wss.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('expected TCP WebSocket server address');
  }

  const connections: WebSocket[] = [];
  const received: unknown[] = [];

  wss.on('connection', (ws) => {
    connections.push(ws);

    ws.on('message', (data) => {
      received.push(JSON.parse(data.toString()));
      ws.send(
        JSON.stringify({
          type: 'response.completed',
          response: { id: `resp_${received.length}` },
        }),
      );
    });
  });

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    connections,
    received,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

async function drainResponsesChat(model: WSLLM, connOptions?: APIConnectOptions): Promise<void> {
  const stream = model.chat({ chatCtx: new agentsLLM.ChatContext(), connOptions });
  for await (const _chunk of stream) {
    void _chunk;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

class FakeRawWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });
  ping = vi.fn();
  send = vi.fn((_data: string, cb: (error?: Error) => void) => cb());
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it('discards a stale reused WebSocket and reconnects in place', async () => {
    const server = await startResponsesServer();
    const model = new WSLLM({ apiKey: 'test-key', baseURL: server.baseURL, model: 'gpt-4.1' });

    try {
      await drainResponsesChat(model);
      expect(server.connections).toHaveLength(1);
      expect(server.received).toHaveLength(1);

      server.connections[0]!.close();
      await waitFor(() => server.connections[0]!.readyState === WebSocket.CLOSED);

      await drainResponsesChat(model);

      expect(server.connections).toHaveLength(2);
      expect(server.received).toHaveLength(2);
    } finally {
      await model.aclose();
      await server.close();
    }
  });

  it('raises a send failure from a fresh WebSocket', async () => {
    const raw = new FakeRawWebSocket();
    raw.send = vi.fn((_data: string, cb: (error?: Error) => void) => cb(new Error('send failed')));
    const transport = new ResponsesWebSocket(raw as unknown as WebSocket);

    await expect(
      transport.sendRequest({ type: 'response.create', model: 'gpt-4.1', input: [], tools: [] }),
    ).rejects.toBeInstanceOf(APIConnectionError);
    expect(raw.send).toHaveBeenCalledTimes(1);
    transport.close();
  });

  it('discards a queued request when send fails', async () => {
    const raw = new FakeRawWebSocket();
    raw.send = vi.fn((_data: string, cb: (error?: Error) => void) => cb(new Error('send failed')));
    const transport = new ResponsesWebSocket(raw as unknown as WebSocket);

    await expect(
      transport.sendRequest({ type: 'response.create', model: 'gpt-4.1', input: [], tools: [] }),
    ).rejects.toBeInstanceOf(APIConnectionError);

    raw.send = vi.fn((_data: string, cb: (error?: Error) => void) => cb());
    const channel = await transport.sendRequest({
      type: 'response.create',
      model: 'gpt-4.1',
      input: [],
      tools: [],
    });
    const reader = channel.stream().getReader();
    raw.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp' } })),
    );

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { type: 'response.completed' },
    });
    reader.releaseLock();
    transport.close();
  });

  it('enables a heartbeat for pooled Responses sockets', () => {
    vi.useFakeTimers();
    const raw = new FakeRawWebSocket();
    const transport = new ResponsesWebSocket(raw as unknown as WebSocket);

    vi.advanceTimersByTime(WS_HEARTBEAT);

    expect(raw.ping).toHaveBeenCalledTimes(1);
    transport.close();
  });
});

if (hasOpenAIApiKey) {
  describe('OpenAI Responses', async () => {
    await pluginLLM(
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
