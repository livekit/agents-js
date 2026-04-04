// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APIConnectionError, APIStatusError } from '../_exceptions.js';
import { connectWs } from './utils.js';

/**
 * Spins up a throwaway HTTP server that responds to WebSocket upgrade requests
 * with a configurable status code instead of completing the handshake.
 */
function createRejectServer(statusCode: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode);
      res.end();
    });
    // Also handle upgrade requests to ensure ws gets the rejection
    server.on('upgrade', (req, socket) => {
      socket.write(
        `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] || 'Unknown'}\r\n\r\n`,
      );
      socket.destroy();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverUrl(server: http.Server): string {
  const addr = server.address() as AddressInfo;
  return `ws://127.0.0.1:${addr.port}`;
}

describe('connectWs', () => {
  const servers: http.Server[] = [];

  afterAll(() => {
    for (const s of servers) {
      s.close();
    }
  });

  it('rejects with APIStatusError(429) for rate-limited responses', async () => {
    const server = await createRejectServer(429);
    servers.push(server);

    const err = await connectWs(serverUrl(server), {}, 5000).catch((e) => e);

    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.statusCode).toBe(429);
    expect(err.message).toBe('LiveKit gateway quota exceeded');
    expect(err.retryable).toBe(true);
  });

  it('rejects with APIStatusError for 401 Unauthorized', async () => {
    const server = await createRejectServer(401);
    servers.push(server);

    const err = await connectWs(serverUrl(server), {}, 5000).catch((e) => e);

    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/Unexpected server response: 401/);
    expect(err.retryable).toBe(false);
  });

  it('rejects with APIStatusError for 500 Internal Server Error', async () => {
    const server = await createRejectServer(500);
    servers.push(server);

    const err = await connectWs(serverUrl(server), {}, 5000).catch((e) => e);

    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.statusCode).toBe(500);
    expect(err.message).toMatch(/Unexpected server response: 500/);
    expect(err.retryable).toBe(true);
  });

  it('rejects with APIConnectionError preserving original message for network errors', async () => {
    // Connect to a port where nothing is listening
    const err = await connectWs('ws://127.0.0.1:1', {}, 5000).catch((e) => e);

    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message).toMatch(/ECONNREFUSED/);
    expect(err.retryable).toBe(true);
  });

  it('rejects with APIConnectionError on timeout', async () => {
    // Create a server that never responds to the upgrade
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);

    const err = await connectWs(serverUrl(server), {}, 100).catch((e) => e);

    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message).toMatch(/Timeout/);
  });
});
