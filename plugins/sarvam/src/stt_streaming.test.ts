// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

let server: ws.WebSocketServer | undefined;
let stream: ReturnType<STT['stream']> | undefined;

interface TestMessage {
  type?: string;
  audio?: {
    data: string;
    encoding: string;
    sample_rate: number;
  };
}

afterEach(async () => {
  stream?.close();
  stream = undefined;
  if (!server) return;
  const currentServer = server;
  for (const client of currentServer.clients) client.terminate();
  await new Promise<void>((resolve) => currentServer.close(() => resolve()));
  server = undefined;
});

async function startServer() {
  server = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  endpoint.url = `ws://127.0.0.1:${address.port}`;

  const messages: TestMessage[] = [];
  let connections = 0;
  server.on('connection', (socket) => {
    connections++;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === 'end_of_stream') socket.close();
    });
  });

  let offset = 0;
  const nextMessage = async () => {
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(offset));
    return messages[offset++]!;
  };

  return {
    get connections() {
      return connections;
    },
    get pendingMessages() {
      return messages.length - offset;
    },
    messages,
    nextMessage,
  };
}

function frame(durationMs: number, value: number) {
  const samples = (16000 * durationMs) / 1000;
  return new AudioFrame(new Int16Array(samples).fill(value), 16000, 1, samples);
}

async function expectAudio(nextMessage: () => Promise<TestMessage>, expected: AudioFrame) {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  while (receivedBytes < expected.data.byteLength) {
    const message = await nextMessage();
    expect(message.type).toBeUndefined();
    expect(message.audio?.encoding).toBe('pcm_s16le');
    expect(message.audio?.sample_rate).toBe(16000);
    const chunk = Buffer.from(message.audio!.data, 'base64');
    expect(chunk.length).toBeGreaterThan(0);
    chunks.push(chunk);
    receivedBytes += chunk.length;
  }
  expect(Buffer.concat(chunks)).toEqual(
    Buffer.from(expected.data.buffer, expected.data.byteOffset, expected.data.byteLength),
  );
}

describe('Sarvam streaming flushes', () => {
  it.each(
    [true, false, undefined].flatMap((flushSignal) =>
      [30, 75].map((firstMs) => ({ flushSignal, firstMs })),
    ),
  )(
    'preserves audio across repeated flushes (flushSignal=$flushSignal, firstMs=$firstMs)',
    async ({ flushSignal, firstMs }) => {
      const peer = await startServer();
      stream = new STT({ apiKey: 'test', flushSignal }).stream();

      for (const [index, durationMs] of [firstMs, 50, 10].entries()) {
        const audio = frame(durationMs, index + 1);
        stream.pushFrame(audio);
        stream.flush();
        await expectAudio(peer.nextMessage, audio);
        if (flushSignal) expect(await peer.nextMessage()).toEqual({ type: 'flush' });
        expect(peer.connections).toBe(1);
      }

      stream.endInput();
      if (flushSignal) expect(await peer.nextMessage()).toEqual({ type: 'flush' });
      expect((await peer.nextMessage()).type).toBe('end_of_stream');
      expect(peer.connections).toBe(1);
      expect(peer.pendingMessages).toBe(0);
    },
  );

  it.each(
    [true, false, undefined].flatMap((flushSignal) =>
      [0, 10].map((tailMs) => ({ flushSignal, tailMs })),
    ),
  )(
    'drains tail audio before ending input (flushSignal=$flushSignal, tailMs=$tailMs)',
    async ({ flushSignal, tailMs }) => {
      const peer = await startServer();
      stream = new STT({ apiKey: 'test', flushSignal }).stream();
      const tail = frame(tailMs, 3);
      if (tailMs > 0) stream.pushFrame(tail);
      stream.endInput();

      if (tailMs > 0) await expectAudio(peer.nextMessage, tail);
      if (flushSignal) expect(await peer.nextMessage()).toEqual({ type: 'flush' });
      expect((await peer.nextMessage()).type).toBe('end_of_stream');
      expect(peer.pendingMessages).toBe(0);
    },
  );

  it('does not send end_of_stream when closed', async () => {
    const peer = await startServer();
    stream = new STT({ apiKey: 'test' }).stream();
    const audio = frame(50, 1);
    stream.pushFrame(audio);
    await expectAudio(peer.nextMessage, audio);
    stream.close();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peer.messages).toHaveLength(1);
  });

  it.each(
    [true, false, undefined].flatMap((flushSignal) =>
      [true, false].map((clientFlushed) => ({ flushSignal, clientFlushed })),
    ),
  )(
    'does not flush the next utterance after server END_SPEECH (flushSignal=$flushSignal, clientFlushed=$clientFlushed)',
    async ({ flushSignal, clientFlushed }) => {
      const peer = await startServer();
      stream = new STT({ apiKey: 'test', flushSignal }).stream();
      const first = frame(50, 1);
      stream.pushFrame(first);
      await expectAudio(peer.nextMessage, first);
      const socket = [...server!.clients][0]!;
      socket.send(JSON.stringify({ type: 'events', data: { signal_type: 'START_SPEECH' } }));
      if (clientFlushed) {
        stream.flush();
        if (flushSignal) expect(await peer.nextMessage()).toEqual({ type: 'flush' });
      }
      socket.send(JSON.stringify({ type: 'events', data: { signal_type: 'END_SPEECH' } }));

      for (const durationMs of [50, 10]) {
        const second = frame(durationMs, 2);
        stream.pushFrame(second);
        if (durationMs === 10) stream.flush();
        await expectAudio(peer.nextMessage, second);
      }
      if (flushSignal) expect(await peer.nextMessage()).toEqual({ type: 'flush' });
      expect(peer.pendingMessages).toBe(0);
    },
  );
});

it('sends all PCM through long silence and flushes the final partial frame', async () => {
  const peer = await startServer();

  const chunks: Buffer[] = [];
  const flushed = new Promise<void>((resolve) => {
    server!.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.audio?.data) {
          chunks.push(Buffer.from(message.audio.data, 'base64'));
        }
        if (message.type === 'flush') resolve();
      });
    });
  });
  stream = new STT({ apiKey: 'test', flushSignal: true }).stream();

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
    expect(peer.connections).toBe(1);
  }
});
