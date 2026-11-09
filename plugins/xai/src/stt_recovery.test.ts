// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  APIConnectionError,
  APIError,
  APIStatusError,
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  log,
  type stt,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

let server: ws.WebSocketServer;
let stream: stt.SpeechStream | undefined;
let session: AgentSession | undefined;
const connOptions = { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 };
async function startServer(options: ws.ServerOptions = {}) {
  server = new ws.WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');
  endpoint.url = `ws://127.0.0.1:${address.port}`;
}
function startStream(maxRetry = 0) {
  const provider = new STT({ apiKey: 'test' });
  const onError = vi.fn();
  provider.on('error', onError);
  stream = provider.stream({ connOptions: { ...connOptions, maxRetry } });
  return { provider, stream, onError };
}
async function drain(value: stt.SpeechStream) {
  for await (const _ of value) {
    /* drain */
  }
}
function frame(value: number) {
  return new AudioFrame(new Int16Array(800).fill(value), 16000, 1, 800);
}
beforeEach(() => {
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
    realSetTimeout(callback, ms === 5000 || ms === 10000 ? 0 : ms, ...args),
  );
});
afterEach(async () => {
  await session?.close();
  session = undefined;
  stream?.close();
  stream = undefined;
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('xai STT recovery', () => {
  it('closes while waiting for the server to become ready', async () => {
    await startServer();
    const connected = once(server, 'connection');
    const { stream, onError } = startStream();
    const [socket] = await connected;
    const ready = once(socket, 'pong');
    socket.ping();
    await ready;
    stream.close();
    await vi.waitFor(() => expect(server.clients.size).toBe(0));
    expect(onError).not.toHaveBeenCalled();
  });
  it.each([1000, 1006, 1011])(
    'preserves an API error after unexpected closure %i',
    async (code) => {
      await startServer();
      server.on('connection', (socket) => {
        if (code === 1006) socket.terminate();
        else socket.close(code);
      });
      const { stream } = startStream();
      await drain(stream);
      expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
    },
  );

  it('reports a rejected handshake without retrying authentication failures', async () => {
    const verifyClient = vi.fn((_info: unknown, done: (ok: boolean, code: number) => void) =>
      done(false, 401),
    );
    await startServer({ verifyClient });
    const { stream } = startStream();
    await drain(stream);
    expect(stream.terminalError).toBeInstanceOf(APIStatusError);
    expect((stream.terminalError as APIStatusError).statusCode).toBe(401);
    expect(verifyClient).toHaveBeenCalledOnce();
  });

  it('delivers every new frame after reconnecting', async () => {
    await startServer();
    let readyConnections = 0;
    const received: number[] = [];
    server.on('connection', (socket) => {
      socket.once('pong', () => {
        socket.send(JSON.stringify({ type: 'transcript.created' }));
        readyConnections++;
      });
      socket.ping();
      socket.on('message', (raw, isBinary) => {
        const pcm = isBinary ? Buffer.from(raw as Buffer) : undefined;
        if (!pcm?.length) return;
        if (readyConnections === 1) socket.close(1011);
        else received.push(pcm.readInt16LE(0));
      });
    });
    const { stream } = startStream(1);
    await vi.waitFor(() => expect(readyConnections).toBe(1));
    stream.pushFrame(frame(100));
    await vi.waitFor(() => expect(readyConnections).toBe(2));
    for (let value = 1; value <= 6; value++) stream.pushFrame(frame(value));
    await vi.waitFor(() => expect(received).toEqual([1, 2, 3, 4, 5, 6]));
  });

  it.each(['close', 'endInput'] as const)('shuts down quietly on %s', async (shutdown) => {
    await startServer();
    let ready = false;
    server.on('connection', (socket) => {
      socket.once('pong', () => {
        socket.send(JSON.stringify({ type: 'transcript.created' }));
        ready = true;
      });
      socket.ping();
      socket.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(raw.toString());
        if (message.type === 'audio.done') socket.close();
      });
    });
    const { stream, onError } = startStream();
    await vi.waitFor(() => expect(ready).toBe(true));
    stream[shutdown]();
    await drain(stream);
    expect(stream.terminalError).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(server.clients.size).toBe(0));
  });
  it('propagates provider errors while the socket stays open', async () => {
    await startServer();
    const sensitive = 'private speech from the caller';
    const body = { type: 'error', message: sensitive, transcript: sensitive };
    const warnLog = vi.spyOn(log(), 'warn');
    const errorLog = vi.spyOn(log(), 'error');
    server.on('connection', (socket) => {
      socket.once('pong', () => socket.send(JSON.stringify(body)));
      socket.ping();
    });
    const { stream } = startStream();
    await drain(stream);
    expect(stream.terminalError).toBeInstanceOf(APIError);
    expect((stream.terminalError as APIError).body).toEqual(body);
    expect(stream.terminalError).toBeInstanceOf(APIStatusError);
    for (const args of [...warnLog.mock.calls, ...errorLog.mock.calls]) {
      const message = typeof args[0] === 'string' ? args[0] : args[1];
      expect(message).not.toContain(sensitive);
    }
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ body }) }),
      expect.any(String),
    );
  });

  it('resumes session transcripts after exhausting plugin retries', async () => {
    await startServer();
    let connections = 0;
    server.on('connection', (socket) => {
      if (++connections <= 33) {
        socket.close(1011);
        return;
      }
      socket.once('pong', () => {
        socket.send(JSON.stringify({ type: 'transcript.created' }));
        socket.send(JSON.stringify({ type: 'transcript.partial', text: 'hello', is_final: false }));
      });
      socket.ping();
    });
    const provider = new STT({ apiKey: 'test' });
    const createStream = vi.spyOn(provider, 'stream');
    session = new AgentSession({
      stt: provider,
      vad: null,
      connOptions: { sttConnOptions: connOptions, maxUnrecoverableErrors: 1 },
      turnHandling: { turnDetection: 'stt', interruption: { enabled: false } },
    });
    const onTranscript = vi.fn();
    const onClose = vi.fn();
    session.on(AgentSessionEventTypes.UserInputTranscribed, onTranscript);
    session.on(AgentSessionEventTypes.Close, onClose);
    await session.start({ agent: new Agent({ instructions: 'test' }) });
    await vi.waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ transcript: 'hello', isFinal: false }),
      ),
    );
    expect(createStream).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });
});
