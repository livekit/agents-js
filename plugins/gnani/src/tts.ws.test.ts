// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError } from '@livekit/agents';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const swallowExpectedRejection = (reason: unknown) => {
  if (reason instanceof APIError) return;
  throw reason;
};
beforeAll(() => process.on('unhandledRejection', swallowExpectedRejection));
afterAll(() => void process.off('unhandledRejection', swallowExpectedRejection));

it('settles an error-before-close abort while a real WebSocket handshake is delayed', async () => {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  let resolveUpgrade: (() => void) | undefined;
  let upgradeSocket: Duplex | undefined;
  let socketClosed: Promise<unknown> | undefined;
  const upgradeStarted = new Promise<void>((resolve) => {
    resolveUpgrade = resolve;
  });
  server.on('upgrade', (_request, socket) => {
    upgradeSocket = socket;
    socket.on('error', () => {});
    socketClosed = new Promise((resolve) => socket.once('close', resolve));
    resolveUpgrade?.();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('local WebSocket server has no TCP address');
  }
  const { port } = address;
  const errors: Error[] = [];
  const tts = new TTS({
    apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${port}`,
    synthesizeMethod: 'websocket',
    container: 'raw',
  });
  tts.on('error', (event) => errors.push(event.error));
  const stream = tts.synthesize('hello', {
    maxRetry: 0,
    retryIntervalMs: 0,
    timeoutMs: 1000,
  });

  await upgradeStarted;
  stream.close();
  upgradeSocket?.destroy();
  await socketClosed;
  await new Promise<void>((resolve) => setImmediate(resolve));

  try {
    expect(errors).toHaveLength(0);
  } finally {
    webSocketServer.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});
