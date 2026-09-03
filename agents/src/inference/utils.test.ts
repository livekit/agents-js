// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { APIConnectionError, APIStatusError, APITimeoutError } from '../_exceptions.js';
import { connectWs } from './utils.js';

const servers: http.Server[] = [];

async function rejectWebSocket(
  statusCode: number,
  body = '',
  contentType = 'text/plain',
): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(statusCode, { 'Content-Type': contentType });
    response.end(body);
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
  it('surfaces a structured gateway error from a rejected handshake', async () => {
    const body = {
      type: 'inference_quota_exceeded',
      error: 'STT connection limit exceeded, category: MaxConcurrentGatewaySTT',
      category: 'MaxConcurrentGatewaySTT',
      current_usage: '55',
      remaining_limit: '0',
      status: 'QuotaStatusExceeded',
    };
    const url = await rejectWebSocket(429, JSON.stringify(body), 'application/json');

    const error = await connectWs(url, {}, 1_000).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({
      message: body.error,
      statusCode: 429,
      retryable: true,
      body,
    });
  });

  it('surfaces a plain-text error from a rejected handshake', async () => {
    const url = await rejectWebSocket(401, 'invalid authorization token');

    const error = await connectWs(url, {}, 1_000).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({
      message: 'invalid authorization token',
      statusCode: 401,
      retryable: false,
      body: null,
    });
  });

  it('falls back to the status when a rejected handshake has no body', async () => {
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
