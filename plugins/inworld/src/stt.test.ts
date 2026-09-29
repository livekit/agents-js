// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STT } from './stt.js';

const SAMPLE_RATE = 16000;
// one 100 ms chunk: the size the stream forwards as a single audioChunk message
const SAMPLES_PER_CHUNK = SAMPLE_RATE / 10;

const servers: WebSocketServer[] = [];

interface Connection {
  socket: WebSocket;
  configured: boolean;
  chunks: number;
}

async function startServer(connections: Connection[]): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');

  server.on('connection', (socket) => {
    const connection: Connection = { socket, configured: false, chunks: 0 };
    connections.push(connection);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if ('transcribeConfig' in message) connection.configured = true;
      if ('audioChunk' in message) connection.chunks++;
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return `ws://127.0.0.1:${address.port}/`;
}

function chunkFrame(): AudioFrame {
  return new AudioFrame(new Int16Array(SAMPLES_PER_CHUNK), SAMPLE_RATE, 1, SAMPLES_PER_CHUNK);
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe('Inworld STT reconnect', () => {
  it.each([
    [
      'updateOptions',
      (stream: ReturnType<STT['stream']>) => stream.updateOptions({ language: 'fr-FR' }),
    ],
    ['a dropped socket', (_stream: unknown, connection?: Connection) => connection?.socket.close()],
  ])('sends every frame on the new connection after %s', async (_name, trigger) => {
    const connections: Connection[] = [];
    const wsURL = await startServer(connections);
    const stream = new STT({ apiKey: 'test-key', wsURL }).stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
    });

    // the config message is sent once the stream is running on the socket
    await waitFor(() => connections[0]?.configured === true);
    trigger(stream, connections[0]);
    await waitFor(() => connections[1]?.configured === true);

    const frames = 6;
    for (let i = 0; i < frames; i++) stream.pushFrame(chunkFrame());
    await waitFor(() => connections[1]!.chunks >= frames, 1000).catch(() => {});

    expect(connections[1]!.chunks).toBe(frames);
    stream.close();
  });
});
