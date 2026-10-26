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

it('sends all PCM through long silence and flushes the final partial frame', async () => {
  const server = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  endpoint.url = `ws://127.0.0.1:${address.port}`;

  const chunks: Buffer[] = [];
  const flushed = new Promise<void>((resolve) => {
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.audio?.data) {
          chunks.push(Buffer.from(message.audio.data, 'base64'));
        }
        if (message.type === 'flush') resolve();
      });
    });
  });
  const stream = new STT({ apiKey: 'test' }).stream();

  try {
    // 200 ms of speech-level audio, two seconds of silence, then 20 ms of quiet audio.
    const pcm = new Int16Array(320 * 111);
    pcm.fill(8192, 0, 320 * 10);
    pcm.fill(32, 320 * 110);
    for (let offset = 0; offset < pcm.length; offset += 320) {
      stream.pushFrame(new AudioFrame(pcm.subarray(offset, offset + 320), 16000, 1, 320));
    }
    stream.flush();
    await flushed;

    const received = Buffer.concat(chunks);
    expect(received.byteLength).toBe(pcm.byteLength);
    expect(received.equals(Buffer.from(pcm.buffer))).toBe(true);
    expect(chunks.at(-1)?.byteLength).toBe(320 * 2);
  } finally {
    stream.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
