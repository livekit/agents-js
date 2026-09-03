// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { APIConnectionError, APIStatusError, APITimeoutError } from '../_exceptions.js';
import { connectWs } from './utils.js';

const servers: http.Server[] = [];

async function rejectWebSocket(statusCode: number): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(statusCode);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('connectWs', () => {
  it('surfaces a 429 response as a retryable status error', async () => {
    const url = await rejectWebSocket(429);

    const error = await connectWs(url, {}, 1_000).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({
      message: 'Unexpected server response: 429',
      statusCode: 429,
      retryable: true,
      body: null,
    });
  });

  it('surfaces a 401 response as a non-retryable status error', async () => {
    const url = await rejectWebSocket(401);

    const error = await connectWs(url, {}, 1_000).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({
      message: 'Unexpected server response: 401',
      statusCode: 401,
      retryable: false,
      body: null,
    });
  });

  it('surfaces a 500 response as a retryable status error', async () => {
    const url = await rejectWebSocket(500);

    const error = await connectWs(url, {}, 1_000).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({
      message: 'Unexpected server response: 500',
      statusCode: 500,
      retryable: true,
      body: null,
    });
  });

  it('preserves the message from a network error', async () => {
    const error = await connectWs('ws://127.0.0.1:1', {}, 1_000).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error).toMatchObject({ retryable: true });
    expect((error as Error).message).toContain('ECONNREFUSED');
  });

  it('times out an unresponsive handshake', async () => {
    const server = http.createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const error = await connectWs(`ws://127.0.0.1:${port}`, {}, 25).catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(APITimeoutError);
    expect((error as Error).message).toBe('Timeout connecting to LiveKit WebSocket');
  });
});
