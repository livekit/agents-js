// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  APIConnectionError,
  APIError,
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  type stt,
} from '@livekit/agents';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ServerOptions, WebSocketServer } from 'ws';
import { STT } from './stt.js';

vi.mock(import('@livekit/agents'), async (importOriginal) => {
  const agents = await importOriginal();
  // Skip the plugin's backoff while exercising real sockets and SDK recovery.
  return { ...agents, delay: async () => {} };
});

const servers: WebSocketServer[] = [];
const streams: stt.SpeechStream[] = [];
const sessions: AgentSession[] = [];
const connOptions = { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 };

async function startServer(options: ServerOptions = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `ws://127.0.0.1:${address.port}` };
}

function startStream(baseUrl: string) {
  const provider = new STT({ apiKey: 'test-key', baseUrl });
  const onError = vi.fn();
  provider.on('error', onError);
  const stream = provider.stream({ connOptions });
  streams.push(stream);
  return { stream, onError };
}

async function drain(stream: stt.SpeechStream) {
  for await (const _ of stream) {
    // Consume events until the attempt ends.
  }
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const stream of streams.splice(0)) stream.close();
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});

describe('AssemblyAI STT recovery', () => {
  it.each([1000, 1006, 1011])(
    'preserves an API error after repeated unexpected socket closures (code %i)',
    async (code) => {
      const { server, baseUrl } = await startServer();
      server.on('connection', (socket) => {
        if (code === 1006) socket.terminate();
        else socket.close(code);
      });
      const { stream, onError } = startStream(baseUrl);

      await drain(stream);

      expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
      expect(stream.terminalError?.message).toContain(String(code));
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ error: stream.terminalError, recoverable: false }),
      );
      expect((stream.terminalError as APIConnectionError).retryable).toBe(true);
    },
  );

  it('reports connection setup failures as API errors', async () => {
    const { baseUrl } = await startServer({
      verifyClient: (_info, done) => done(false, 503, 'Unavailable'),
    });
    const { stream } = startStream(baseUrl);

    await drain(stream);

    expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
  });

  it('resumes session transcripts after the plugin exhausts its retries', async () => {
    const { server, baseUrl } = await startServer();
    let connections = 0;
    server.on('connection', (socket) => {
      connections++;
      if (connections <= 33) {
        socket.close(1011);
      } else {
        socket.once('pong', () => {
          socket.send(
            JSON.stringify({
              type: 'Turn',
              words: [{ text: 'hello', start: 0, end: 480, confidence: 1 }],
              end_of_turn: false,
            }),
          );
        });
        socket.ping();
      }
    });
    const provider = new STT({ apiKey: 'test-key', baseUrl });
    const createStream = vi.spyOn(provider, 'stream');
    const session = new AgentSession({
      stt: provider,
      vad: null,
      connOptions: { sttConnOptions: connOptions, maxUnrecoverableErrors: 1 },
      turnHandling: { turnDetection: 'stt', interruption: { enabled: false } },
    });
    sessions.push(session);
    const onTranscript = vi.fn();
    const onClose = vi.fn();
    session.on(AgentSessionEventTypes.UserInputTranscribed, onTranscript);
    session.on(AgentSessionEventTypes.Close, onClose);

    await session.start({ agent: new Agent({ instructions: 'test' }) });

    await vi.waitFor(
      () =>
        expect(onTranscript).toHaveBeenCalledWith(
          expect.objectContaining({ transcript: 'hello', isFinal: false }),
        ),
      { timeout: 2000 },
    );
    expect(createStream).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not classify message parsing failures as connection errors', async () => {
    const { server, baseUrl } = await startServer();
    server.on('connection', (socket) => {
      socket.once('pong', () => socket.send('invalid JSON'));
      socket.ping();
    });
    const { stream } = startStream(baseUrl);

    await drain(stream);

    expect(stream.terminalError).toBeInstanceOf(Error);
    expect(stream.terminalError).not.toBeInstanceOf(APIError);
  });

  it.each(['close', 'endInput'] as const)(
    'does not report an error or reconnect on %s',
    async (shutdown) => {
      const { server, baseUrl } = await startServer();
      const onConnection = vi.fn();
      server.on('connection', (socket) => {
        onConnection();
        socket.on('message', (data) => {
          if (JSON.parse(data.toString()).type === 'Terminate') {
            socket.send(JSON.stringify({ type: 'Termination' }));
            socket.close();
          }
        });
      });
      const connected = once(server, 'connection');
      const { stream, onError } = startStream(baseUrl);
      const [socket] = await connected;
      const ready = once(socket, 'pong');
      socket.ping();
      await ready;
      const disconnected = once(socket, 'close');

      stream[shutdown]();
      await disconnected;
      await drain(stream);

      expect(stream.terminalError).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
      expect(onConnection).toHaveBeenCalledTimes(1);
    },
  );
});
