// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
} from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import { type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const hasCartesiaConfig = Boolean(process.env.CARTESIA_API_KEY && process.env.OPENAI_API_KEY);

if (hasCartesiaConfig) {
  describe('Cartesia', async () => {
    await testTts(new TTS(), new STT());
  });
} else {
  describe('Cartesia', () => {
    it.skip('requires CARTESIA_API_KEY and OPENAI_API_KEY', () => {});
  });
}

// A single 24 kHz mono s16le frame's worth of silence, base64-encoded the way
// Cartesia sends audio chunks.
const CHUNK_BASE64 = Buffer.alloc(4800).toString('base64');
const CURRENT_CHUNK = Buffer.alloc(4800, 1);

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

// A minimal Cartesia /tts/bytes server. `onRequest` receives the parsed JSON
// body and writes the response; the returned `requests` collects every body.
async function startBytesServer(
  onRequest: (body: Record<string, unknown>, res: ServerResponse) => void,
): Promise<{ server: Server; baseURL: string; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      onRequest(body, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseURL: `http://127.0.0.1:${address.port}`, requests };
}

async function closeBytesServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function synthesizeBytes(
  cartesia: TTS,
  text: string,
  connOptions?: APIConnectOptions,
): Promise<tts.SynthesizedAudio[]> {
  const stream = cartesia.synthesize(text, connOptions);
  try {
    const events: tts.SynthesizedAudio[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    return events;
  } finally {
    stream.close();
  }
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for promise')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// A minimal Cartesia TTS WebSocket server: for every generation it replies with
// one audio chunk and a done message, echoing the caller's context_id. `onStop`
// lets a test override the reply (e.g. to simulate a provider failure); return
// false to suppress the normal chunk/done reply.
function serveCartesia(
  wss: WebSocketServer,
  onStop?: (ws: WebSocket, contextId: string, connectionNumber: number) => boolean,
): { connectionCount: () => number } {
  let connectionCount = 0;
  wss.on('connection', (ws) => {
    connectionCount++;
    const connectionNumber = connectionCount;
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { context_id: string; continue?: boolean };
      if (message.continue !== false) return; // only reply once the turn is closed
      const contextId = message.context_id;
      if (onStop && !onStop(ws, contextId, connectionNumber)) return;
      ws.send(
        JSON.stringify({
          type: 'chunk',
          data: CHUNK_BASE64,
          done: false,
          status_code: 200,
          step_time: 0,
          context_id: contextId,
        }),
      );
      ws.send(
        JSON.stringify({ type: 'done', done: true, status_code: 200, context_id: contextId }),
      );
    });
  });
  return { connectionCount: () => connectionCount };
}

async function synthesizeTurn(
  cartesia: TTS,
  text: string,
  connOptions?: APIConnectOptions,
): Promise<tts.SynthesizedAudio[]> {
  const stream = cartesia.stream({ connOptions });
  stream.pushText(text);
  stream.endInput();

  try {
    const events: tts.SynthesizedAudio[] = [];
    for await (const event of stream) {
      if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
    }
    return events;
  } finally {
    stream.close();
  }
}

describe('Cartesia streaming pool', () => {
  it('redacts API keys from WebSocket handshake errors', async () => {
    const secret = 'cartesia-secret-api-key-do-not-log';
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, done) => done(false, 401, 'Unauthorized'),
    });
    await once(wss, 'listening');
    const address = wss.address() as AddressInfo;
    const cartesia = new TTS({ apiKey: secret, baseUrl: `http://127.0.0.1:${address.port}` });
    const errorEvent = once(cartesia, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;

    try {
      const stream = cartesia.stream({
        connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
      });
      stream.pushText('test');
      stream.endInput();

      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
      expect(error.message).not.toContain(secret);
      expect(error.toString()).not.toContain(secret);
      stream.close();
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('does not retain generic WebSocket connection errors', async () => {
    const secret = 'cartesia-secret-api-key-do-not-log';
    const cartesia = new TTS({ apiKey: secret, baseUrl: `http://[${secret}` });
    const errorEvent = once(cartesia, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;

    try {
      const stream = cartesia.stream({
        connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
      });
      stream.pushText('test');
      stream.endInput();

      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIConnectionError);
      expect(error.message).toBe('SyntaxError');
      expect(error.message).not.toContain(secret);
      expect(error.toString()).not.toContain(secret);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      stream.close();
    } finally {
      await cartesia.close();
    }
  });

  it('reuses one websocket across sequential turns', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveCartesia(wss);

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      expect(await synthesizeTurn(cartesia, 'first turn.')).not.toHaveLength(0);
      expect(await synthesizeTurn(cartesia, 'second turn.')).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(1);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('ignores stale frames from a previous context on a pooled websocket', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    serveCartesia(wss, (ws, contextId) => {
      ws.send(
        JSON.stringify({
          type: 'chunk',
          data: CHUNK_BASE64,
          done: false,
          status_code: 200,
          step_time: 0,
          context_id: 'stale-context-id',
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'done',
          done: true,
          status_code: 200,
          context_id: 'stale-context-id',
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'chunk',
          data: CURRENT_CHUNK.toString('base64'),
          done: false,
          status_code: 200,
          step_time: 0,
          context_id: contextId,
        }),
      );
      ws.send(
        JSON.stringify({ type: 'done', done: true, status_code: 200, context_id: contextId }),
      );
      return false;
    });

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      const events = await synthesizeTurn(cartesia, 'current turn.');
      expect(events).not.toHaveLength(0);
      expect(
        events.every((event) =>
          Buffer.from(
            event.frame.data.buffer,
            event.frame.data.byteOffset,
            event.frame.data.byteLength,
          ).equals(CURRENT_CHUNK),
        ),
      ).toBe(true);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('prewarms and reuses the ready websocket', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveCartesia(wss);
    const connected = once(wss, 'connection');

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      cartesia.prewarm();
      await waitFor(connected);
      expect(await synthesizeTurn(cartesia, 'prewarmed turn.')).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(1);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('discards a poisoned websocket after a failure', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    // The first connection drops the turn; the second serves it normally.
    const server = serveCartesia(wss, (ws, _contextId, connectionNumber) => {
      if (connectionNumber === 1) {
        ws.close(1011, 'provider failure');
        return false;
      }
      return true;
    });

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      expect(
        await synthesizeTurn(cartesia, 'failing turn.', {
          ...DEFAULT_API_CONNECT_OPTIONS,
          maxRetry: 0,
        }),
      ).toHaveLength(0);
      expect(await synthesizeTurn(cartesia, 'recovery turn.')).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(2);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('fails over when the socket drops mid-generation instead of ending silently', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    // Connection 1 emits one audio chunk, then drops WITHOUT a done message,
    // i.e. mid-speech. Connection 2 serves the recovery turn normally.
    const server = serveCartesia(wss, (ws, contextId, connectionNumber) => {
      if (connectionNumber === 1) {
        ws.send(
          JSON.stringify({
            type: 'chunk',
            data: CHUNK_BASE64,
            done: false,
            status_code: 200,
            step_time: 0,
            context_id: contextId,
          }),
        );
        setTimeout(() => ws.close(1011, 'mid-speech drop'), 5);
        return false; // suppress the normal chunk/done reply
      }
      return true;
    });

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      // The dropped turn does not complete successfully (it fails over rather
      // than silently ending); at maxRetry: 0 that surfaces as no audio.
      expect(
        await synthesizeTurn(cartesia, 'dropping turn.', {
          ...DEFAULT_API_CONNECT_OPTIONS,
          maxRetry: 0,
        }),
      ).toHaveLength(0);
      // The dead socket is discarded, so the next turn opens a fresh one.
      expect(await synthesizeTurn(cartesia, 'recovery turn.')).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(2);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('replaces a websocket that closed while idle', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let firstConnectionClosed: (() => void) | undefined;
    const firstClosed = new Promise<void>((resolve) => {
      firstConnectionClosed = resolve;
    });
    const server = serveCartesia(wss, (ws, _contextId, connectionNumber) => {
      if (connectionNumber === 1) {
        ws.on('close', () => firstConnectionClosed?.());
        // Serve the turn, then drop the idle socket so the next turn reconnects.
        setTimeout(() => ws.close(), 10);
      }
      return true;
    });

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      expect(await synthesizeTurn(cartesia, 'first turn.')).not.toHaveLength(0);
      await waitFor(firstClosed);
      // Let the client observe the close so the idle handler removes the socket
      // before the next checkout, making the maxRetry: 0 assertion deterministic.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // maxRetry: 0 proves the idle-closed socket was dropped from the pool, not
      // handed back to burn the turn's only attempt.
      expect(
        await waitFor(
          synthesizeTurn(cartesia, 'second turn.', { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 }),
        ),
      ).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(2);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('closes the pooled websocket when the TTS closes', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    serveCartesia(wss);

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      await synthesizeTurn(cartesia, 'closing turn.');
      await cartesia.close();
      // close() drains the pooled socket; give the close frame a beat to land.
      await waitFor(
        (async () => {
          while (wss.clients.size > 0) await new Promise((r) => setTimeout(r, 5));
        })(),
      );
      expect(wss.clients.size).toBe(0);
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});

describe('Cartesia /tts/bytes', () => {
  // A failed ChunkedStream also rejects its background task; the error event is
  // the surface under test here.
  const swallowExpectedRejection = (reason: unknown) => {
    if (reason instanceof APIStatusError) return;
    throw reason;
  };
  beforeAll(() => process.on('unhandledRejection', swallowExpectedRejection));
  afterAll(() => void process.off('unhandledRejection', swallowExpectedRejection));

  it('omits the websocket-only max_buffer_delay_ms field', async () => {
    const { server, baseURL, requests } = await startBytesServer((_body, res) => {
      res.writeHead(200, { 'content-type': 'audio/pcm' });
      res.end(CURRENT_CHUNK);
    });

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      const events = await synthesizeBytes(cartesia, 'hello.');
      expect(events).not.toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ transcript: 'hello.' });
      expect(requests[0]).not.toHaveProperty('max_buffer_delay_ms');
    } finally {
      await cartesia.close();
      await closeBytesServer(server);
    }
  });

  it('surfaces a rejected response as APIStatusError instead of silent empty audio', async () => {
    const { server, baseURL, requests } = await startBytesServer((_body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Invalid request: max buffer delay is only supported for websocket requests',
        }),
      );
    });

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    const errors: { error: Error }[] = [];
    cartesia.on('error', (error) => errors.push(error));
    try {
      expect(await synthesizeBytes(cartesia, 'hello.')).toHaveLength(0);
      expect(errors).toHaveLength(1);
      const error = errors[0]!.error;
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(400);
      expect(error.message).toContain('max buffer delay is only supported for websocket requests');
      // A 4xx is not retried, so the default connect options made exactly one request.
      expect(requests).toHaveLength(1);
    } finally {
      await cartesia.close();
      await closeBytesServer(server);
    }
  });

  it('retries a 5xx response', async () => {
    const { server, baseURL, requests } = await startBytesServer((_body, res) => {
      if (requests.length === 1) {
        res.writeHead(503);
        res.end('upstream unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/pcm' });
      res.end(CURRENT_CHUNK);
    });

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      const events = await synthesizeBytes(cartesia, 'hello.', {
        ...DEFAULT_API_CONNECT_OPTIONS,
        maxRetry: 1,
        retryIntervalMs: 0,
      });
      expect(events).not.toHaveLength(0);
      expect(requests).toHaveLength(2);
    } finally {
      await cartesia.close();
      await closeBytesServer(server);
    }
  });

  it('keeps max_buffer_delay_ms on websocket generations', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const packets: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => packets.push(JSON.parse(raw.toString())));
    });
    serveCartesia(wss);

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      expect(await synthesizeTurn(cartesia, 'hello.')).not.toHaveLength(0);
      expect(packets.length).toBeGreaterThan(0);
      for (const packet of packets) {
        expect(packet).toMatchObject({ max_buffer_delay_ms: 0 });
      }
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });
});
