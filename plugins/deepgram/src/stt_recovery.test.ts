// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, type stt } from '@livekit/agents';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';
import { STTv2 } from './stt_v2.js';

let server: WebSocketServer;
let stream: stt.SpeechStream | undefined;

async function startServer() {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP server');
  return `ws://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  stream?.close();
  for (const socket of server?.clients ?? []) socket.terminate();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('Deepgram STT error recovery', () => {
  it('preserves API errors when v1 exhausts its reconnect attempts', async () => {
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
      schedule(callback, ms === 5000 || ms === 10000 ? 0 : ms, ...args),
    );
    const baseUrl = await startServer();
    server.on('connection', (socket) => socket.close(1011));
    const provider = new STT({ apiKey: 'test', baseUrl });
    const onError = vi.fn();
    provider.on('error', onError);
    stream = provider.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 } });
    for await (const _ of stream) {
      /* drain */
    }
    expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ error: stream.terminalError }),
    );
  });

  it('propagates a v2 provider error without waiting for the socket to close', async () => {
    const endpointUrl = await startServer();
    const body = { type: 'Error', description: 'service unavailable' };
    server.on('connection', (socket) => {
      socket.once('pong', () => socket.send(JSON.stringify(body)));
      socket.ping();
    });
    const provider = new STTv2({ apiKey: 'test', endpointUrl });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 } });
    await vi.waitFor(() => expect(stream?.terminalError).toBeInstanceOf(APIStatusError));
    expect(stream.terminalError?.message).toContain('service unavailable');
  });
});
