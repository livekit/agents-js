// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { createServer } from 'node:http';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STT } from './stt.js';
import { TTS } from './tts.js';

const swallowExpectedRejection = (reason: unknown) => {
  if (reason instanceof APIError) return;
  throw reason;
};
beforeAll(() => process.on('unhandledRejection', swallowExpectedRejection));
afterAll(() => void process.off('unhandledRejection', swallowExpectedRejection));

async function establishedServer() {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  const connected = new Promise<{ peer: WebSocket; socket: Socket; closed: Promise<void> }>(
    (resolve, reject) => {
      webSocketServer.once('connection', (peer) => {
        const socket = Reflect.get(peer, '_socket');
        if (!(socket instanceof Socket)) {
          reject(new Error('real WebSocket has no network socket'));
          return;
        }
        const closed = new Promise<void>((resolveClose) => socket.once('close', resolveClose));
        resolve({ peer, socket, closed });
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('local WebSocket server has no TCP address');
  }
  return {
    port: address.port,
    connected,
    async close() {
      for (const peer of webSocketServer.clients) peer.terminate();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    },
  };
}

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

it('forcefully settles an established TTS socket when the peer ignores close frames', async () => {
  const local = await establishedServer();
  const errors: Error[] = [];
  const tts = new TTS({
    apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${local.port}`,
    synthesizeMethod: 'websocket',
    container: 'raw',
  });
  tts.on('error', (event) => errors.push(event.error));
  const stream = tts.synthesize('hello', {
    maxRetry: 0,
    retryIntervalMs: 0,
    timeoutMs: 1000,
  });
  const { socket, closed } = await local.connected;
  socket.pause();

  try {
    stream.close();
    await closed;

    expect(socket.destroyed).toBe(true);
    expect(errors).toHaveLength(0);
  } finally {
    await local.close();
  }
});

it('forcefully settles established STT after its first text response', async () => {
  const local = await establishedServer();
  const errors: Error[] = [];
  const stt = new STT({
    apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${local.port}`,
  });
  stt.on('error', (event) => errors.push(event.error));
  const stream = stt.stream({
    connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
  });
  const { peer, socket, closed } = await local.connected;
  const receivedAudio = new Promise<void>((resolve) => peer.once('message', () => resolve()));
  stream.pushFrame(AudioFrame.create(16000, 1, 2400));
  await receivedAudio;
  await new Promise<void>((resolve, reject) => {
    peer.send(
      JSON.stringify({ type: 'transcript', text: 'ready', segment_id: 'segment-1' }),
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
  const result = await stream.next();
  expect(result.value?.alternatives[0]?.text).toBe('ready');
  socket.pause();

  try {
    stream.close();
    await closed;

    expect(socket.destroyed).toBe(true);
    expect(errors).toHaveLength(0);
  } finally {
    await local.close();
  }
});
