// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STT } from './stt.js';

const SpeechEventType = stt.SpeechEventType;
const SAMPLE_RATE = 16000;
// the stream forwards audio in chunks of 512 samples at 16 kHz
const SAMPLES_PER_CHUNK = 512;

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
    socket.on('message', (_data, isBinary) => {
      if (isBinary) {
        connection.chunks++;
      } else {
        connection.configured = true;
      }
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return `ws://127.0.0.1:${address.port}`;
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

describe('Baseten STT reconnect', () => {
  it('reconnects after the server drops the socket and sends every frame on the new one', async () => {
    const connections: Connection[] = [];
    const modelEndpoint = await startServer(connections);
    const stream = new STT({ apiKey: 'test-key', modelEndpoint }).stream();

    // the metadata message is sent once the stream is running on the socket
    await waitFor(() => connections[0]?.configured === true);
    connections[0]!.socket.close();
    await waitFor(() => connections[1]?.configured === true);

    const frames = 4;
    for (let i = 0; i < frames; i++) stream.pushFrame(chunkFrame());
    await waitFor(() => connections[1]!.chunks >= frames, 1000).catch(() => {});

    expect(connections[1]!.chunks).toBe(frames);
    expect(connections[0]!.chunks).toBe(0);
    stream.close();
  });

  it('ends the active speech turn when the socket drops and starts a new one after reconnect', async () => {
    const connections: Connection[] = [];
    const modelEndpoint = await startServer(connections);
    const stream = new STT({ apiKey: 'test-key', modelEndpoint }).stream();
    const types: stt.SpeechEventType[] = [];
    void (async () => {
      for await (const event of stream) types.push(event.type);
    })();

    const interim = JSON.stringify({ is_final: false, transcript: 'hello' });
    await waitFor(() => connections[0]?.configured === true);
    connections[0]!.socket.send(interim);
    await waitFor(() => types.length >= 2);
    connections[0]!.socket.close();
    await waitFor(() => connections[1]?.configured === true);
    connections[1]!.socket.send(interim);
    await waitFor(() => types.length >= 5);

    expect(types).toEqual([
      SpeechEventType.START_OF_SPEECH,
      SpeechEventType.INTERIM_TRANSCRIPT,
      SpeechEventType.END_OF_SPEECH,
      SpeechEventType.START_OF_SPEECH,
      SpeechEventType.INTERIM_TRANSCRIPT,
    ]);
    stream.close();
  });

  it('keeps samples buffered before the drop and sends them on the new socket', async () => {
    const connections: Connection[] = [];
    const modelEndpoint = await startServer(connections);
    const stream = new STT({ apiKey: 'test-key', modelEndpoint }).stream();

    await waitFor(() => connections[0]?.configured === true);
    const partial = (samples: number) =>
      new AudioFrame(new Int16Array(samples), SAMPLE_RATE, 1, samples);
    stream.pushFrame(partial(160));
    await new Promise((resolve) => setTimeout(resolve, 100));
    connections[0]!.socket.close();
    await waitFor(() => connections[1]?.configured === true);
    stream.pushFrame(partial(SAMPLES_PER_CHUNK - 160));
    await waitFor(() => connections[1]!.chunks >= 1, 1000).catch(() => {});

    expect(connections[1]!.chunks).toBe(1);
    stream.close();
  });

  it('does not reconnect after the stream is closed', async () => {
    const connections: Connection[] = [];
    const modelEndpoint = await startServer(connections);
    const stream = new STT({ apiKey: 'test-key', modelEndpoint }).stream();

    await waitFor(() => connections[0]?.configured === true);
    stream.close();
    await waitFor(() => connections[0]!.socket.readyState === 3);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(connections).toHaveLength(1);
  });
});
