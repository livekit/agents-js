// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import * as ws from 'ws';
import { STT } from './stt.js';

const endpoint = vi.hoisted(() => ({ url: '' }));

vi.mock('ws', async (importOriginal) => {
  const original = await importOriginal<typeof ws>();
  return {
    ...original,
    WebSocket: class extends original.WebSocket {
      constructor(_url: string, options: ws.ClientOptions) {
        super(endpoint.url, options);
      }
    },
  };
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

it('delivers every frame to the new connection after a reconnect', async () => {
  const server = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  endpoint.url = `ws://127.0.0.1:${address.port}`;

  let connections = 0;
  let secondConnectionBytes = 0;
  server.on('connection', (socket) => {
    connections += 1;
    if (connections === 1) {
      // the first socket drops, which makes the stream reconnect
      setTimeout(() => socket.close(), 50);
      return;
    }
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.audio?.data) {
        secondConnectionBytes += Buffer.from(message.audio.data, 'base64').byteLength;
      }
    });
  });

  const stream = new STT({ apiKey: 'test' }).stream();
  try {
    await waitUntil(() => connections >= 2, 8000);

    // 600 ms of 16 kHz mono PCM as six 100 ms frames
    const frames = 6;
    for (let i = 0; i < frames; i++) {
      const pcm = new Int16Array(1600).fill(8192);
      stream.pushFrame(new AudioFrame(pcm, 16000, 1, 1600));
    }

    // The connection that ended must not keep a read open on the shared audio queue and take
    // frames that belong to this one.
    const expected = frames * 1600 * 2;
    await waitUntil(() => secondConnectionBytes >= expected, 3000);
    expect(secondConnectionBytes).toBe(expected);
  } finally {
    stream.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20000);
