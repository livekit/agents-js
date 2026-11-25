// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import { type Server, createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { APIConnectionError, APIStatusError, APITimeoutError } from '../../_exceptions.js';
import { initializeLogger } from '../../log.js';
import type { InterruptionCacheEntry } from './interruption_cache_entry.js';
import { BoundedCache } from './utils.js';
import { type WsTransportOptions, createWsTransport } from './ws_transport.js';

function createOptions(port: number, connectTimeout = 1000): WsTransportOptions {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    sampleRate: 16000,
    minFrames: 2,
    timeout: 500,
    connectTimeout,
    maxRetries: 0,
  };
}

function createTransport(port: number, connectTimeout?: number) {
  return createWsTransport(
    createOptions(port, connectTimeout),
    () => ({
      overlapSpeechStarted: false,
      overlapSpeechStartedAt: undefined,
      cache: new BoundedCache<number, InterruptionCacheEntry>(10),
    }),
    () => {},
  );
}

/** Resolves with the error that the transport's readable side fails with. */
async function streamError(readable: ReadableStream<unknown>): Promise<unknown> {
  try {
    await readable.getReader().read();
  } catch (err) {
    return err;
  }
  throw new Error('expected the stream to fail');
}

// Lets deferred `process.nextTick` / socket events from a teardown run.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

describe('createWsTransport', () => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);

  // Any `ws` error that escapes as an uncaught exception would also fail the vitest run; recording
  // it here makes the assertion explicit.
  beforeAll(() => {
    initializeLogger({ level: 'silent', pretty: false });
    process.on('uncaughtException', onUncaught);
  });

  afterAll(() => {
    process.off('uncaughtException', onUncaught);
  });

  async function listen(
    setup?: (server: Server) => void,
  ): Promise<{ server: Server; port: number }> {
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket) => sockets.add(socket));
    setup?.(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, port: (server.address() as AddressInfo).port };
  }

  afterEach(async () => {
    await settle();
    expect(uncaught).toEqual([]);
    uncaught.length = 0;
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            // Upgraded or stalled sockets are not tracked by closeAllConnections().
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => resolve());
          }),
      ),
    );
    vi.restoreAllMocks();
  });

  describe('failed handshake', () => {
    it('reports a rejected upgrade as APIStatusError', async () => {
      const { port } = await listen((server) =>
        server.on('upgrade', (_req, socket) => {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        }),
      );

      const { transport } = createTransport(port);
      const error = await streamError(transport.readable);

      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
    });

    it('reports a stalled handshake as APITimeoutError', async () => {
      // Accept the upgrade request but never answer it.
      const { port } = await listen((server) => server.on('upgrade', () => {}));

      const { transport } = createTransport(port, 100);
      const error = await streamError(transport.readable);

      expect(error).toBeInstanceOf(APITimeoutError);
    });

    it('reports a refused connection as APIConnectionError', async () => {
      const { port } = await listen();
      await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));

      const { transport } = createTransport(port);
      const error = await streamError(transport.readable);

      expect(error).toBeInstanceOf(APIConnectionError);
    });
  });

  describe('error listener guard', () => {
    it('keeps an error listener on the socket between open and the stream handlers', async () => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(wss, 'listening');
      const { port } = wss.address() as AddressInfo;

      // Inject a socket error on the tick right after the client socket opens, before the
      // transport has had a chance to continue from `await connectWebSocket()`.
      const emit = WebSocket.prototype.emit;
      let escaped: unknown;
      let injected = false;
      vi.spyOn(WebSocket.prototype, 'emit').mockImplementation(function (
        this: WebSocket,
        event: string | symbol,
        ...args: unknown[]
      ) {
        const result = emit.call(this, event, ...args);
        // Only the client socket has a URL; the server-side peer emits 'open' as well.
        if (event === 'open' && this.url) {
          process.nextTick(() => {
            try {
              emit.call(this, 'error', new Error('injected socket error'));
            } catch (err) {
              escaped = err;
            }
            injected = true;
          });
        }
        return result;
      });

      const { close } = createTransport(port);
      try {
        await vi.waitFor(() => expect(injected).toBe(true));
        expect(escaped).toBeUndefined();
      } finally {
        close();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    });
  });

  describe('abandoned sockets', () => {
    // Client sockets only: the server-side peers are WebSocket instances too.
    function captureClientSockets(method: 'terminate' | 'close'): Set<WebSocket> {
      const captured = new Set<WebSocket>();
      const original = WebSocket.prototype[method];
      vi.spyOn(WebSocket.prototype, method).mockImplementation(function (
        this: WebSocket,
        ...args: unknown[]
      ) {
        if (this.url) captured.add(this);
        return (original as (...a: unknown[]) => void).apply(this, args);
      });
      return captured;
    }

    it('keeps an error listener on a socket whose handshake failed', async () => {
      const { port } = await listen((server) =>
        server.on('upgrade', (_req, socket) => {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        }),
      );
      const terminated = captureClientSockets('terminate');

      const { transport } = createTransport(port);
      await streamError(transport.readable);
      await settle();

      expect(terminated.size).toBe(1);
      const [socket] = terminated;
      expect(() => socket!.emit('error', new Error('late error'))).not.toThrow();
    });

    it('keeps an error listener on a socket replaced by reconnect() and does not fail the stream', async () => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(wss, 'listening');
      const { port } = wss.address() as AddressInfo;
      const sessions: string[] = [];
      wss.on('connection', (peer) =>
        peer.on('message', (data) => sessions.push(JSON.parse(data.toString()).type)),
      );
      const closed = captureClientSockets('close');

      const { transport, reconnect, close } = createTransport(port);
      const reader = transport.readable.getReader();
      let failure: unknown;
      reader.read().catch((err) => (failure = err));
      await vi.waitFor(() => expect(sessions).toEqual(['session.create']));

      await reconnect();
      await vi.waitFor(() =>
        expect(sessions).toEqual(['session.create', 'session.close', 'session.create']),
      );

      // The first socket was abandoned: a late error must be swallowed rather than thrown or
      // forwarded to the stream that now belongs to the replacement socket.
      expect(closed.size).toBe(1);
      const [abandoned] = closed;
      expect(() => abandoned!.emit('error', new Error('late error'))).not.toThrow();
      await settle();
      expect(failure).toBeUndefined();

      close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
  });

  describe('close() during the handshake', () => {
    it('does not create a gateway session on a socket that opens after close()', async () => {
      const wss = new WebSocketServer({ noServer: true });
      const { server, port } = await listen();
      // Hold the upgrade so close() lands while the client socket is still CONNECTING.
      const upgrade = once(server, 'upgrade');

      const { close } = createTransport(port);
      const [request, socket, head] = await upgrade;
      close();

      const received: string[] = [];
      const closeCode = Promise.withResolvers<number>();
      wss.handleUpgrade(request, socket, head, (peer) => {
        peer.on('message', (data) => received.push(JSON.parse(data.toString()).type));
        peer.once('close', (code) => closeCode.resolve(code));
      });

      expect(await closeCode.promise).toBe(1000);
      expect(received).toEqual([]);
      wss.close();
    });
  });

  describe('normal lifecycle', () => {
    it('opens a session on connect and closes it on close()', async () => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(wss, 'listening');
      const { port } = wss.address() as AddressInfo;

      const received: string[] = [];
      const closeCode = Promise.withResolvers<number>();
      wss.on('connection', (peer) => {
        peer.on('message', (data) => received.push(JSON.parse(data.toString()).type));
        peer.once('close', (code) => closeCode.resolve(code));
      });

      const { close } = createTransport(port);
      await vi.waitFor(() => expect(received).toEqual(['session.create']));

      close();
      expect(await closeCode.promise).toBe(1000);
      expect(received).toEqual(['session.create', 'session.close']);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
  });
});
