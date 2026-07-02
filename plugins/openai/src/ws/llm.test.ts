// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, llm as core, initializeLogger } from '@livekit/agents';
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { LLM } from '../responses/llm.js';
import { ResponsesWebSocket, WSLLM, buildResponsesWsUrl } from './llm.js';
import type { WsResponseCreateEvent } from './types.js';

initializeLogger({ level: 'silent', pretty: false });

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

describe('buildResponsesWsUrl', () => {
  it('points at the OpenAI Responses WS endpoint with model when no baseURL is set', () => {
    const url = new URL(buildResponsesWsUrl(undefined, 'gpt-4.1'));

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.openai.com');
    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4.1');
  });

  it('rewrites https baseURL to wss and appends /responses with the model', () => {
    const url = new URL(buildResponsesWsUrl('https://gateway.example.com/v1', 'gpt-4o'));

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('gateway.example.com');
    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4o');
  });

  it('strips a trailing slash on baseURL before appending /responses', () => {
    const url = new URL(buildResponsesWsUrl('https://gateway.example.com/v1/', 'gpt-4o-mini'));

    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4o-mini');
  });

  it('rewrites http baseURL to ws (not wss)', () => {
    const url = new URL(buildResponsesWsUrl('http://gateway.example.com/v1', 'gpt-4o-mini'));

    expect(url.protocol).toBe('ws:');
    expect(url.host).toBe('gateway.example.com');
    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4o-mini');
  });

  it('strips a trailing slash on an http baseURL before appending /responses', () => {
    const url = new URL(buildResponsesWsUrl('http://gateway.example.com/v1/', 'gpt-4o-mini'));

    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4o-mini');
  });
});

// ============================================================================
// Receive-side (first-event / inactivity) timeout
// ============================================================================

/**
 * Minimal `ws.WebSocket` stand-in for ResponsesWebSocket. Only implements the
 * surface the wrapper touches: `readyState`, `on`/`emit`, `send`, and `close`.
 */
function createFakeWebSocket() {
  const emitter = new EventEmitter() as EventEmitter & {
    readyState: number;
    sent: string[];
    send: (data: string) => void;
    close: () => void;
    emitServerEvent: (event: unknown) => void;
  };
  emitter.readyState = WebSocket.OPEN;
  emitter.sent = [];
  emitter.send = (data: string) => {
    emitter.sent.push(data);
  };
  emitter.close = () => {
    if (emitter.readyState === WebSocket.CLOSED) return;
    emitter.readyState = WebSocket.CLOSED;
    emitter.emit('close');
  };
  emitter.emitServerEvent = (event: unknown) => {
    emitter.emit('message', Buffer.from(JSON.stringify(event)));
  };
  return emitter;
}

const basePayload: WsResponseCreateEvent = {
  type: 'response.create',
  model: 'gpt-4.1',
  input: [],
  tools: [],
};

async function readResult<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

describe('ResponsesWebSocket receive-side timeout', () => {
  it('aborts the request with a retryable error when no event arrives in time', async () => {
    const ws = createFakeWebSocket();
    const conn = new ResponsesWebSocket(ws as unknown as WebSocket);

    const channel = conn.sendRequest(basePayload, 30);
    const reader = channel.stream().getReader();

    // The reader must reject (not hang forever) once the deadline elapses.
    const { error } = await readResult(reader.read());

    expect(error).toBeInstanceOf(APIConnectionError);
    expect((error as APIConnectionError).retryable).toBe(true);
    // A silent socket is torn down so the pool reconnects on the next turn.
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('aborts on an inactivity gap after the first event', async () => {
    const ws = createFakeWebSocket();
    const conn = new ResponsesWebSocket(ws as unknown as WebSocket);

    const channel = conn.sendRequest(basePayload, 40);
    const reader = channel.stream().getReader();

    // First event arrives promptly and resets the idle deadline...
    ws.emitServerEvent({ type: 'response.created', response: { id: 'resp_1' } });
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('response.created');

    // ...but the stream then goes silent, so the next read still times out.
    const { error } = await readResult(reader.read());
    expect(error).toBeInstanceOf(APIConnectionError);
    expect((error as APIConnectionError).retryable).toBe(true);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('does not fire when events arrive promptly', async () => {
    const ws = createFakeWebSocket();
    const conn = new ResponsesWebSocket(ws as unknown as WebSocket);

    const channel = conn.sendRequest(basePayload, 50);
    const reader = channel.stream().getReader();

    ws.emitServerEvent({ type: 'response.created', response: { id: 'resp_1' } });
    ws.emitServerEvent({ type: 'response.completed', response: { id: 'resp_1' } });

    const created = await reader.read();
    expect(created.value?.type).toBe('response.created');
    const completed = await reader.read();
    expect(completed.value?.type).toBe('response.completed');

    // Terminal event closes the channel cleanly; the timer never fires.
    const end = await reader.read();
    expect(end.done).toBe(true);

    // Wait past the (cleared) deadline to prove no spurious teardown occurs.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('never arms a timer when the timeout is disabled (0)', async () => {
    const ws = createFakeWebSocket();
    const conn = new ResponsesWebSocket(ws as unknown as WebSocket);

    const channel = conn.sendRequest(basePayload, 0);
    const reader = channel.stream().getReader();

    // Well past what would have been any reasonable deadline.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.emitServerEvent({ type: 'response.completed', response: { id: 'resp_1' } });
    const completed = await reader.read();
    expect(completed.value?.type).toBe('response.completed');
  });
});

// ============================================================================
// Parallel-generation guard (previous_response_id continuation)
// ============================================================================

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * In-process Responses WebSocket server for exercising WSLLM end-to-end without
 * hitting OpenAI. Records every `response.create` payload it receives and lets
 * each test script the server's replies per request.
 */
class FakeResponsesServer {
  readonly requests: WsResponseCreateEvent[] = [];
  #wss: WebSocketServer;
  #handler: (conn: WebSocket, payload: WsResponseCreateEvent, index: number) => void = () => {};
  #waiters: Array<{ count: number; d: Deferred }> = [];

  private constructor(wss: WebSocketServer) {
    this.#wss = wss;
    wss.on('connection', (conn) => {
      conn.on('message', (data: Buffer) => {
        const payload = JSON.parse(data.toString()) as WsResponseCreateEvent;
        const index = this.requests.push(payload) - 1;
        this.#handler(conn, payload, index);
        for (const w of this.#waiters) {
          if (this.requests.length >= w.count) w.d.resolve();
        }
      });
    });
  }

  static async start(): Promise<FakeResponsesServer> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    return new FakeResponsesServer(wss);
  }

  get port(): number {
    return (this.#wss.address() as AddressInfo).port;
  }

  onRequest(
    handler: (conn: WebSocket, payload: WsResponseCreateEvent, index: number) => void,
  ): void {
    this.#handler = handler;
  }

  waitForRequests(count: number): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve();
    const d = deferred();
    this.#waiters.push({ count, d });
    return d.promise;
  }

  async close(): Promise<void> {
    for (const client of this.#wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }
}

function sendCreated(conn: WebSocket, id: string): void {
  conn.send(JSON.stringify({ type: 'response.created', response: { id } }));
}
function sendDelta(conn: WebSocket, delta: string): void {
  conn.send(JSON.stringify({ type: 'response.output_text.delta', delta }));
}
function sendCompleted(conn: WebSocket, id: string): void {
  conn.send(JSON.stringify({ type: 'response.completed', response: { id } }));
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of stream) {
    // consume
  }
}

function userCtx(items: core.ChatItem[], text: string): core.ChatContext {
  const ctx = new core.ChatContext([...items]);
  ctx.addMessage({ role: 'user', content: text });
  return ctx;
}

describe('WSLLM parallel-generation guard', () => {
  let server: FakeResponsesServer;
  let wsllm: WSLLM;

  afterEach(async () => {
    await wsllm?.close();
    await server?.close();
  });

  it('continues from previous_response_id across serial turns', async () => {
    server = await FakeResponsesServer.start();
    // Disable the receive-side deadline so these deterministic tests can't flake.
    wsllm = new WSLLM({
      apiKey: 'test',
      model: 'gpt-4.1',
      baseURL: `http://localhost:${server.port}`,
      responseTimeoutMs: 0,
    });

    let n = 0;
    server.onRequest((conn) => {
      const id = `resp_${++n}`;
      sendCreated(conn, id);
      sendCompleted(conn, id);
    });

    const ctx1 = userCtx([], 'hello');
    await drain(wsllm.chat({ chatCtx: ctx1 }));

    const ctx2 = userCtx(ctx1.items, 'again');
    await drain(wsllm.chat({ chatCtx: ctx2 }));

    // The second serial turn chains off the first response.
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.previous_response_id).toBe('resp_1');
  });

  it('suppresses continuation during overlap and resets the chain afterwards', async () => {
    server = await FakeResponsesServer.start();
    wsllm = new WSLLM({
      apiKey: 'test',
      model: 'gpt-4.1',
      baseURL: `http://localhost:${server.port}`,
      responseTimeoutMs: 0,
    });

    const holdFirst = deferred();
    let n = 0;
    server.onRequest(async (conn, _payload, index) => {
      const id = `resp_${++n}`;
      sendCreated(conn, id);
      sendDelta(conn, 'x'); // gives the client an observable first chunk
      if (index === 0) {
        // Keep the first generation in flight until the test releases it.
        await holdFirst.promise;
      }
      sendCompleted(conn, id);
    });

    // Turn A: start consuming and wait until its first chunk lands, which proves
    // response.created was processed (so prev_response_id is now stored) and A
    // is still active (its completion is being withheld).
    const firstChunkA = deferred();
    const ctxA = userCtx([], 'a');
    const pA = (async () => {
      for await (const _chunk of wsllm.chat({ chatCtx: ctxA })) {
        firstChunkA.resolve();
      }
    })();
    await firstChunkA.promise;

    // Turn B starts while A is still active. Even though a stored
    // previous_response_id exists, the guard must NOT chain off it.
    const ctxB = userCtx(ctxA.items, 'b');
    await drain(wsllm.chat({ chatCtx: ctxB }));

    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.previous_response_id).toBeUndefined();

    // Release A and let it finish; overlap must reset the stored chain.
    holdFirst.resolve();
    await pA;

    // Turn C is serial again, but because overlap corrupted (and reset) the
    // chain, it must re-send full context without a previous_response_id.
    const ctxC = userCtx(ctxB.items, 'c');
    await drain(wsllm.chat({ chatCtx: ctxC }));

    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]!.previous_response_id).toBeUndefined();
  });

  it('reserves synchronously so two chats in the same tick do not both continue', async () => {
    server = await FakeResponsesServer.start();
    wsllm = new WSLLM({
      apiKey: 'test',
      model: 'gpt-4.1',
      baseURL: `http://localhost:${server.port}`,
      responseTimeoutMs: 0,
    });

    let n = 0;
    server.onRequest((conn) => {
      const id = `resp_${++n}`;
      sendCreated(conn, id);
      sendCompleted(conn, id);
    });

    // Establish a stored continuation chain (resp_1).
    const ctx1 = userCtx([], 'hello');
    await drain(wsllm.chat({ chatCtx: ctx1 }));

    // Issue two turns in the SAME tick (no await between the chat() calls). The
    // reservation must be synchronous: the first may chain off resp_1, but the
    // second must observe the first as in-flight and re-send full context.
    // (If _onStreamStarted only ran inside the deferred run(), both would read
    // #activeStreams === 0 and both would continue off resp_1.)
    const s2a = wsllm.chat({ chatCtx: userCtx(ctx1.items, 'a') });
    const s2b = wsllm.chat({ chatCtx: userCtx(ctx1.items, 'b') });
    await Promise.all([drain(s2a), drain(s2b)]);

    const overlapping = [server.requests[1]!, server.requests[2]!];
    // Exactly one of the two same-tick turns continued off resp_1.
    expect(overlapping.filter((r) => r.previous_response_id === 'resp_1')).toHaveLength(1);
    expect(overlapping.filter((r) => !r.previous_response_id)).toHaveLength(1);
  });

  it('stays reserved across retry attempts, not just the first', async () => {
    server = await FakeResponsesServer.start();
    wsllm = new WSLLM({
      apiKey: 'test',
      model: 'gpt-4.1',
      baseURL: `http://localhost:${server.port}`,
      responseTimeoutMs: 0,
    });

    // The public LLM wrapper always subscribes to 'error'; mirror that here so
    // the retryable error below doesn't trip EventEmitter's unhandled-'error'
    // throw when driving WSLLM directly.
    wsllm.on('error', () => {});

    const holdRetry = deferred();
    server.onRequest(async (conn, _payload, index) => {
      if (index === 0) {
        // S1 attempt 1: retryable failure -> the base class retries (first retry
        // is immediate). If the reservation were released in run()'s finally, the
        // counter would drop to 0 here for the rest of S1's lifetime.
        conn.send(
          JSON.stringify({
            type: 'error',
            error: { code: 'websocket_connection_limit_reached', message: 'boom' },
          }),
        );
      } else if (index === 1) {
        // S1 attempt 2 (retry): produce an observable first chunk, then hold the
        // turn open so S1 is unambiguously still in flight.
        sendCreated(conn, 'resp_2');
        sendDelta(conn, 'x');
        await holdRetry.promise;
        sendCompleted(conn, 'resp_2');
      } else {
        // Concurrent turn S2.
        sendCreated(conn, `resp_s2_${index}`);
        sendCompleted(conn, `resp_s2_${index}`);
      }
    });

    // Drive S1 with a single retry; resolve once its retried attempt emits a chunk.
    const s1Retrying = deferred();
    const ctxS1 = userCtx([], 's1');
    const pS1 = (async () => {
      for await (const _chunk of wsllm.chat({
        chatCtx: ctxS1,
        connOptions: { maxRetry: 1, retryIntervalMs: 10, timeoutMs: 10_000 },
      })) {
        s1Retrying.resolve();
      }
    })();
    await s1Retrying.promise;

    // S1's retried attempt has stored resp_2 and is still active. A concurrent
    // turn must NOT chain off it (with a per-attempt release it would, because
    // #activeStreams would have dropped to 0 after S1's first attempt failed).
    const ctxS2 = userCtx(ctxS1.items, 's2');
    await drain(wsllm.chat({ chatCtx: ctxS2 }));

    expect(server.requests.at(-1)!.previous_response_id).toBeUndefined();

    holdRetry.resolve();
    await pS1;
  });
});

if (hasOpenAIApiKey) {
  describe('OpenAI Responses WS wrapper', async () => {
    await llm(
      new LLM({
        temperature: 0,
        strictToolSchema: false,
        useWebSocket: true,
      }),
      true,
    );
  });

  describe('OpenAI Responses WS wrapper strict tool schema', async () => {
    await llmStrict(
      new LLM({
        temperature: 0,
        strictToolSchema: true,
        useWebSocket: true,
      }),
    );
  });
} else {
  describe('OpenAI Responses WS wrapper', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
