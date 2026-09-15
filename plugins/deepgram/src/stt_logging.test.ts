// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '@livekit/agents';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STT } from './stt.js';
import { STTv2 } from './stt_v2.js';

const servers: WebSocketServer[] = [];
const streams: Array<{ close(): void }> = [];

async function startServer(onConnection?: (socket: WebSocket) => void): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await once(server, 'listening');
  if (onConnection) server.on('connection', onConnection);

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return `ws://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  vi.restoreAllMocks();
});

describe('Deepgram STT logging', () => {
  it('logs invalid messages as text with the parse error', async () => {
    const errorSpy = vi.spyOn(log(), 'error');
    const baseUrl = await startServer((socket) => {
      setTimeout(() => socket.send('not-json'), 10);
    });
    const recognizer = new STT({ apiKey: 'test', baseUrl });
    const stream = recognizer.stream();
    streams.push(stream);

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        {
          error: expect.any(SyntaxError),
          'lk.pii.message': 'not-json',
        },
        'Deepgram STT failed to process message',
      );
    });
  });

  it('does not log the v2 connection URL', async () => {
    const debugSpy = vi.spyOn(log(), 'debug');
    const baseUrl = await startServer();
    const recognizer = new STTv2({
      apiKey: 'test',
      endpointUrl: `${baseUrl}/v2/listen`,
      keyterms: ['private-keyterm'],
    });
    const stream = recognizer.stream();
    streams.push(stream);

    await vi.waitFor(() => {
      const connectionCalls = debugSpy.mock.calls.filter((call) =>
        call.includes('connecting to Deepgram'),
      );
      expect(connectionCalls).toEqual([['connecting to Deepgram']]);
      expect(JSON.stringify(connectionCalls)).not.toContain('private-keyterm');
    });
  });
});
