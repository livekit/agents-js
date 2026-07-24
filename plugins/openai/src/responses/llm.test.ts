// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  ConnectionPool,
  llm as agentsLLM,
} from '@livekit/agents';
import { llmStrict, llm as pluginLLM } from '@livekit/agents-plugins-test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { type Socket, createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ResponsesWebSocket,
  WSLLM,
  WSLLMStream,
  WS_HEARTBEAT,
  buildResponsesWsUrl,
} from '../ws/llm.js';
import { wsServerEventSchema } from '../ws/types.js';
import { LLM } from './llm.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);
const NO_RETRY: APIConnectOptions = {
  maxRetry: 0,
  retryIntervalMs: 0,
  timeoutMs: 500,
};

type ResponsesRequest = {
  connectionIndex: number;
  request: Record<string, unknown>;
  ws: WebSocket;
};

function sendSuccessfulResponse(ws: WebSocket, responseId: string): void {
  ws.send(JSON.stringify({ type: 'response.created', response: { id: responseId } }));
  ws.send(
    JSON.stringify({
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          total_tokens: 3,
          input_tokens_details: { cached_tokens: 1 },
        },
      },
    }),
  );
}

async function startResponsesServer(
  onRequest?: (request: ResponsesRequest, requestIndex: number) => void,
) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));

  const address = wss.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('expected TCP WebSocket server address');
  }

  const connections: WebSocket[] = [];
  const received: ResponsesRequest[] = [];

  wss.on('connection', (ws) => {
    connections.push(ws);
    const connectionIndex = connections.length - 1;

    ws.on('message', (data) => {
      const receivedRequest = {
        connectionIndex,
        request: JSON.parse(data.toString()) as Record<string, unknown>,
        ws,
      };
      received.push(receivedRequest);
      if (onRequest) {
        onRequest(receivedRequest, received.length);
      } else {
        sendSuccessfulResponse(ws, `resp_${received.length}`);
      }
    });
  });

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    connections,
    received,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

async function startUpgradeBoundary(mode: 'hang' | 'unauthorized') {
  if (mode === 'hang') {
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createNetServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.resume();
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected TCP server address');
    }
    return {
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      get upgrades() {
        return connections;
      },
      get openSockets() {
        return sockets.size;
      },
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  const server = createServer();
  const sockets = new Set<Socket>();
  let upgrades = 0;

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_request, socket) => {
    upgrades += 1;
    const body = JSON.stringify({ error: { code: 'invalid_api_key' } });
    socket.end(
      [
        'HTTP/1.1 401 Unauthorized',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('expected TCP server address');
  }

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    get upgrades() {
      return upgrades;
    },
    get openSockets() {
      return sockets.size;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function drainResponsesChat(model: WSLLM, connOptions?: APIConnectOptions): Promise<void> {
  const stream = model.chat({ chatCtx: new agentsLLM.ChatContext(), connOptions });
  for await (const _chunk of stream) {
    void _chunk;
  }
}

async function connectResponsesWebSocket(baseURL: string): Promise<ResponsesWebSocket> {
  const ws = new WebSocket(buildResponsesWsUrl(baseURL, 'gpt-4.1'), {
    headers: { Authorization: 'Bearer test-key' },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return new ResponsesWebSocket(ws);
}

class ManuallyRunWSLLMStream extends WSLLMStream {
  protected override async run(): Promise<void> {
    // Suppress the base LLMStream's automatically scheduled run in this focused harness.
  }

  execute(): Promise<void> {
    return super.run();
  }
}

function createManualStream(
  model: WSLLM,
  pool: ConnectionPool<ResponsesWebSocket>,
): ManuallyRunWSLLMStream {
  return new ManuallyRunWSLLMStream(model, {
    pool,
    model: 'gpt-4.1',
    chatCtx: new agentsLLM.ChatContext(),
    fullChatCtx: new agentsLLM.ChatContext(),
    connOptions: NO_RETRY,
    modelOptions: {},
    strictToolSchema: true,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
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
      await drainResponsesChat(model, NO_RETRY);
      expect(server.connections).toHaveLength(1);
      expect(server.received).toHaveLength(1);

      server.connections[0]!.close();
      await waitFor(() => server.connections[0]!.readyState === WebSocket.CLOSED);

      await drainResponsesChat(model, NO_RETRY);

      expect(server.connections).toHaveLength(2);
      expect(server.received).toHaveLength(2);
    } finally {
      await model.aclose();
      await server.close();
    }
  });

  it('eagerly connects without surfacing a constructor-time rejection', async () => {
    const boundary = await startUpgradeBoundary('unauthorized');
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    const model = new WSLLM({
      apiKey: 'invalid-key',
      baseURL: boundary.baseURL,
      model: 'gpt-4.1',
    });

    try {
      await waitFor(() => boundary.upgrades === 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await model.aclose();
      await boundary.close();
    }
  });

  it('aborts and cleans up an in-flight eager connection on shutdown', async () => {
    const boundary = await startUpgradeBoundary('hang');
    const model = new WSLLM({
      apiKey: 'test-key',
      baseURL: boundary.baseURL,
      model: 'gpt-4.1',
    });

    try {
      await waitFor(() => boundary.upgrades === 1);
      await model.aclose();
      await waitFor(() => boundary.openSockets === 0);
    } finally {
      await model.aclose();
      await boundary.close();
    }
  });

  it('propagates cancellation through foreground connection creation', async () => {
    const server = await startResponsesServer();
    const model = new WSLLM({
      apiKey: 'test-key',
      baseURL: server.baseURL,
      model: 'gpt-4.1',
    });
    let connectSignal: AbortSignal | undefined;
    let connectStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      connectStarted = resolve;
    });
    const connectCb = vi.fn(
      (_timeout: number, signal?: AbortSignal) =>
        new Promise<ResponsesWebSocket>((_resolve, reject) => {
          connectSignal = signal;
          connectStarted();
          if (!signal) {
            reject(new Error('missing connection abort signal'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const pool = new ConnectionPool<ResponsesWebSocket>({ connectCb });
    const stream = createManualStream(model, pool);

    try {
      const execution = stream.execute();
      await started;
      stream.close();
      await execution;

      expect(connectSignal?.aborted).toBe(true);
    } finally {
      stream.close();
      await pool.close();
      await model.aclose();
      await server.close();
    }
  });

  it('reconnects after a known stale 401 while preserving IDs and metrics', async () => {
    const server = await startResponsesServer(({ ws }, requestIndex) => {
      if (requestIndex === 2) {
        ws.send(
          JSON.stringify({
            type: 'error',
            status: 401,
            error: {
              code: 'websocket_closed',
              message: 'cached WebSocket closed while idle',
            },
          }),
        );
        return;
      }
      sendSuccessfulResponse(ws, requestIndex === 1 ? 'resp_initial' : 'resp_reconnected');
    });
    const model = new WSLLM({ apiKey: 'test-key', baseURL: server.baseURL, model: 'gpt-4.1' });
    const errors: { error: Error; recoverable: boolean }[] = [];
    const metricRequestIds: string[] = [];
    model.on('error', (error) => errors.push(error));
    model.on('metrics_collected', (metrics) => metricRequestIds.push(metrics.requestId));

    try {
      await drainResponsesChat(model, NO_RETRY);
      await drainResponsesChat(model, {
        maxRetry: 1,
        retryIntervalMs: 0,
        timeoutMs: 500,
      });
      await waitFor(() => errors.length === 1);
      await waitFor(() => metricRequestIds.includes('resp_reconnected'));

      expect(errors[0]!.error).toBeInstanceOf(APIConnectionError);
      expect(errors[0]!.recoverable).toBe(true);
      expect(server.connections).toHaveLength(2);
      expect(server.received.map(({ connectionIndex }) => connectionIndex)).toEqual([0, 0, 1]);
      expect(metricRequestIds).toContain('resp_initial');
      expect(metricRequestIds).toContain('resp_reconnected');
    } finally {
      await model.aclose();
      await server.close();
    }
  });

  it('does not retry an unrelated authentication 401', async () => {
    const server = await startResponsesServer(({ ws }) => {
      ws.send(
        JSON.stringify({
          type: 'error',
          status: 401,
          code: 'invalid_api_key',
          message: 'invalid API key',
        }),
      );
    });
    const model = new WSLLM({
      apiKey: 'test-key',
      baseURL: server.baseURL,
      model: 'gpt-4.1',
    });
    const connectCb = vi.fn((_timeout: number, _signal?: AbortSignal) =>
      connectResponsesWebSocket(server.baseURL),
    );
    const pool = new ConnectionPool<ResponsesWebSocket>({
      connectCb,
      closeCb: async (connection) => connection.close(),
    });
    const stream = createManualStream(model, pool);

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const error = await stream.execute().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
      expect((error as APIStatusError).retryable).toBe(false);
      expect(connectCb).toHaveBeenCalledTimes(1);
    } finally {
      stream.close();
      await pool.close();
      await model.aclose();
      await server.close();
    }
  });

  it('does not retry a fresh WebSocket send failure', async () => {
    const server = await startResponsesServer();
    const raw = new FakeRawWebSocket();
    raw.send = vi.fn((_data: string, cb: (error?: Error) => void) => cb(new Error('send failed')));
    const connection = new ResponsesWebSocket(raw as unknown as WebSocket);
    const connectCb = vi.fn(async () => connection);
    const pool = new ConnectionPool<ResponsesWebSocket>({
      connectCb,
      closeCb: async (conn) => conn.close(),
    });
    const model = new WSLLM({ apiKey: 'test-key', baseURL: server.baseURL, model: 'gpt-4.1' });
    const stream = createManualStream(model, pool);

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const error = await stream.execute().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(APIConnectionError);
      expect(connectCb).toHaveBeenCalledTimes(1);
      expect(raw.send).toHaveBeenCalledTimes(1);
    } finally {
      stream.close();
      await pool.close();
      await model.aclose();
      await server.close();
    }
  });

  it('stops after six stale reused send failures', async () => {
    const server = await startResponsesServer();
    const rawSockets = Array.from({ length: 6 }, () => {
      const raw = new FakeRawWebSocket();
      raw.send = vi.fn((_data: string, cb: (error?: Error) => void) =>
        cb(new Error('stale send failed')),
      );
      return raw;
    });
    let nextSocket = 0;
    const connectCb = vi.fn(async () => {
      const raw = rawSockets[nextSocket++];
      if (!raw) throw new Error('unexpected seventh connection');
      return new ResponsesWebSocket(raw as unknown as WebSocket);
    });
    const pool = new ConnectionPool<ResponsesWebSocket>({
      connectCb,
      closeCb: async (conn) => conn.close(),
    });
    const connections = await Promise.all(Array.from({ length: 6 }, () => pool.get()));
    for (const connection of connections) pool.put(connection);
    const model = new WSLLM({ apiKey: 'test-key', baseURL: server.baseURL, model: 'gpt-4.1' });
    const stream = createManualStream(model, pool);

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const error = await stream.execute().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(APIConnectionError);
      expect(connectCb).toHaveBeenCalledTimes(6);
      expect(rawSockets.every((raw) => raw.send.mock.calls.length === 1)).toBe(true);
    } finally {
      stream.close();
      await pool.close();
      await model.aclose();
      await server.close();
    }
  });

  it('closes the socket when a pending response is cancelled', async () => {
    const server = await startResponsesServer(() => {
      // Keep the response pending until the client cancels the stream.
    });
    const model = new WSLLM({ apiKey: 'test-key', baseURL: server.baseURL, model: 'gpt-4.1' });

    try {
      const response = model.chat({
        chatCtx: new agentsLLM.ChatContext(),
        connOptions: NO_RETRY,
      });
      await waitFor(() => server.received.length === 1);
      response.close();

      await waitFor(() => server.connections[0]?.readyState === WebSocket.CLOSED);
    } finally {
      await model.aclose();
      await server.close();
    }
  });

  it('raises a send failure from a fresh WebSocket', async () => {
    const raw = new FakeRawWebSocket();
    raw.send = vi.fn((_data: string, cb: (error?: Error) => void) => cb(new Error('send failed')));
    const transport = new ResponsesWebSocket(raw as unknown as WebSocket);

    const channel = transport.sendRequest({
      type: 'response.create',
      model: 'gpt-4.1',
      input: [],
      tools: [],
    });
    const reader = channel.stream().getReader();

    await expect(reader.read()).rejects.toBeInstanceOf(APIConnectionError);
    expect(raw.send).toHaveBeenCalledTimes(1);
    reader.releaseLock();
    transport.close();
  });

  it('discards a queued request when send fails', async () => {
    const raw = new FakeRawWebSocket();
    raw.send = vi.fn((_data: string, cb: (error?: Error) => void) => cb(new Error('send failed')));
    const transport = new ResponsesWebSocket(raw as unknown as WebSocket);

    const failedChannel = transport.sendRequest({
      type: 'response.create',
      model: 'gpt-4.1',
      input: [],
      tools: [],
    });
    const failedReader = failedChannel.stream().getReader();

    await expect(failedReader.read()).rejects.toBeInstanceOf(APIConnectionError);
    failedReader.releaseLock();

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

  it('keeps a responsive pooled socket alive across heartbeats', () => {
    vi.useFakeTimers();
    const raw = new FakeRawWebSocket();
    const transport = new ResponsesWebSocket(raw as unknown as WebSocket);

    vi.advanceTimersByTime(WS_HEARTBEAT);
    raw.emit('pong');
    vi.advanceTimersByTime(WS_HEARTBEAT);

    expect(raw.ping).toHaveBeenCalledTimes(2);
    expect(raw.terminate).not.toHaveBeenCalled();
    transport.close();
  });

  it('terminates a pooled socket that misses its heartbeat pong', () => {
    vi.useFakeTimers();
    const raw = new FakeRawWebSocket();
    const transport = new ResponsesWebSocket(raw as unknown as WebSocket);

    vi.advanceTimersByTime(WS_HEARTBEAT * 2);

    expect(raw.ping).toHaveBeenCalledTimes(1);
    expect(raw.terminate).toHaveBeenCalledTimes(1);
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
