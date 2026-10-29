// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

// Pinned rather than imported: changing the API attribution must fail this test.
const API_SOURCE = 'livekit-plugin';

describe('Gradium API source', () => {
  it('identifies the STT plugin in websocket headers', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const headers = new Promise<{ apiKey?: string; apiSource?: string }>((resolve) => {
      server.once('connection', (_socket, request) => {
        resolve({
          apiKey: request.headers['x-api-key'] as string | undefined,
          apiSource: request.headers['x-api-source'] as string | undefined,
        });
      });
    });

    const gradium = new STT({
      apiKey: 'test-key',
      modelEndpoint: `ws://127.0.0.1:${address.port}`,
    });
    const stream = gradium.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    const consume = (async () => {
      for await (const _ of stream) {
        // Drain events while the websocket is active.
      }
    })();

    try {
      await expect(headers).resolves.toEqual({
        apiKey: 'test-key',
        apiSource: API_SOURCE,
      });
    } finally {
      stream.close();
      await consume;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
