// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { APIConnectionError, APIStatusError, APITimeoutError } from '../../_exceptions.js';
import type { InterruptionCacheEntry } from './interruption_cache_entry.js';
import { BoundedCache } from './utils.js';
import { type WsTransportOptions, createWsTransport } from './ws_transport.js';

function createTransportOptions(port: number, connectTimeout = 200): WsTransportOptions {
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

function defaultState() {
  return {
    overlapSpeechStarted: false,
    overlapSpeechStartedAt: undefined,
    cache: new BoundedCache<number, InterruptionCacheEntry>(10),
  };
}

async function listenServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected ephemeral TCP port');
  }
  return { server, port: address.port };
}

async function drainStreamError(readable: ReadableStream<unknown>): Promise<unknown> {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return undefined;
    }
  } catch (err) {
    return err;
  } finally {
    reader.releaseLock();
  }
}

describe('createWsTransport real WebSocket teardown error handling', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (srv) =>
          new Promise<void>((resolve) => {
            srv.closeAllConnections?.();
            srv.close(() => resolve());
          }),
      ),
    );
  });

  it('surfaces APIStatusError on 401 unexpected-response without unhandled ws error events', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    try {
      const { server, port } = await listenServer((_req, res) => {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Unauthorized');
      });
      servers.push(server);

      const { transport, close } = createWsTransport(
        createTransportOptions(port),
        defaultState,
        () => {},
      );

      const err = await drainStreamError(transport.readable);
      await new Promise((r) => setTimeout(r, 50));
      close();

      expect(err).toBeInstanceOf(APIStatusError);
      expect((err as APIStatusError).statusCode).toBe(401);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('surfaces APITimeoutError on connect timeout without unhandled ws error events', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    try {
      // Accept TCP + HTTP upgrade request without responding so connectTimeout triggers ws.terminate()
      const { server, port } = await listenServer((_req, _res) => {});
      servers.push(server);

      const { transport, close } = createWsTransport(
        createTransportOptions(port, 40),
        defaultState,
        () => {},
      );

      const err = await drainStreamError(transport.readable);
      await new Promise((r) => setTimeout(r, 50));
      close();

      expect(err).toBeInstanceOf(APITimeoutError);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('surfaces APIConnectionError on refused port without unhandled ws error events', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    try {
      const { server, port } = await listenServer((_req, res) => res.end());
      await new Promise<void>((resolve) => server.close(() => resolve()));

      const { transport, close } = createWsTransport(
        createTransportOptions(port, 500),
        defaultState,
        () => {},
      );

      const err = await drainStreamError(transport.readable);
      await new Promise((r) => setTimeout(r, 50));
      close();

      expect(err).toBeInstanceOf(APIConnectionError);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('keeps an error listener on failed handshake sockets so delayed abortHandshake errors are caught', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    const origTerminate = WebSocket.prototype.terminate;
    // Simulate a runtime where microtasks (finally { ws.removeAllListeners() })
    // drain before abortHandshake()'s deferred 'error' fires on the socket.
    WebSocket.prototype.terminate = function patchedTerminate(this: WebSocket) {
      setTimeout(() => {
        this.emit('error', new Error('WebSocket was closed before the connection was established'));
      }, 10);
      return origTerminate.call(this);
    };

    try {
      const { server, port } = await listenServer((_req, res) => {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Unauthorized');
      });
      servers.push(server);

      const { transport, close } = createWsTransport(
        createTransportOptions(port),
        defaultState,
        () => {},
      );

      const err = await drainStreamError(transport.readable);
      await new Promise((r) => setTimeout(r, 60));
      close();

      expect(err).toBeInstanceOf(APIStatusError);
      expect(uncaught).toEqual([]);
    } finally {
      WebSocket.prototype.terminate = origTerminate;
      process.off('uncaughtException', onUncaught);
    }
  });

  it('closes cleanly on closeSocket teardown even if the abandoned socket emits an error', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const address = wss.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected ephemeral TCP port');
    }

    const origClose = WebSocket.prototype.close;
    WebSocket.prototype.close = function patchedClose(
      this: WebSocket,
      code?: number,
      data?: string | Buffer,
    ) {
      if (!wss.clients.has(this)) {
        setTimeout(() => {
          this.emit('error', new Error('late socket teardown error'));
        }, 10);
      }
      return origClose.call(this, code, data);
    };

    try {
      const connected = new Promise<void>((resolve) => {
        wss.once('connection', (socket) => {
          socket.once('message', () => resolve());
        });
      });

      const { close } = createWsTransport(
        createTransportOptions(address.port),
        defaultState,
        () => {},
      );

      await connected;
      close();
      await new Promise((r) => setTimeout(r, 50));

      expect(uncaught).toEqual([]);
    } finally {
      WebSocket.prototype.close = origClose;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      process.off('uncaughtException', onUncaught);
    }
  });
});
