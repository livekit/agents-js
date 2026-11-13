// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, APITimeoutError, stt } from '@livekit/agents';
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

let server: ws.WebSocketServer;
let stream: stt.SpeechStream | undefined;
const connOptions = { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 };
async function startServer(options: ws.ServerOptions = {}) {
  server = new ws.WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');
  endpoint.url = `ws://127.0.0.1:${address.port}`;
}
function startStream(maxRetry = 0, timeoutMs = connOptions.timeoutMs) {
  const provider = new STT({ apiKey: 'test', modelEndpoint: endpoint.url });
  const onError = vi.fn();
  provider.on('error', onError);
  stream = provider.stream({ connOptions: { ...connOptions, maxRetry, timeoutMs } });
  return { provider, stream, onError };
}
async function drain(value: stt.SpeechStream) {
  for await (const _ of value) {
    /* drain */
  }
}
function frame(value: number) {
  return new AudioFrame(new Int16Array(512).fill(value), 16000, 1, 512);
}
function samples(count: number) {
  return new AudioFrame(new Int16Array(count), 16000, 1, count);
}
afterEach(async () => {
  stream?.close();
  stream = undefined;
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('baseten STT recovery', () => {
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

  it.each(['close', 'endInput'] as const)(
    'shuts down quietly on %s',
    async (shutdown) => {
      await startServer();
      let ready = false;
      server.on('connection', (socket) => {
        socket.once('pong', () => {
          ready = true;
        });
        socket.ping();
      });
      const { stream, onError } = startStream();
      await vi.waitFor(() => expect(ready).toBe(true));
      stream[shutdown]();
      await drain(stream);
      expect(stream.terminalError).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(server.clients.size).toBe(0));
    },
    10_000,
  );

  it('flushes buffered audio and delivers the final transcript when input ends', async () => {
    await startServer();
    let audioBytes = 0;
    const textMessages: unknown[] = [];
    server.on('connection', (socket) => {
      let metadataReceived = false;
      socket.on('message', (raw, isBinary) => {
        if (isBinary) {
          const audio = raw as Buffer[] | Buffer | ArrayBuffer;
          audioBytes += Array.isArray(audio) ? Buffer.concat(audio).byteLength : audio.byteLength;
          return;
        }
        const message = JSON.parse(raw.toString());
        if (!metadataReceived) {
          metadataReceived = true;
          return;
        }
        textMessages.push(message);
        if (message.type !== 'end_audio') return;
        socket.send(JSON.stringify({ type: 'end_audio', body: { status: 'acknowledged' } }));
        socket.send(
          JSON.stringify({
            type: 'transcription',
            is_final: true,
            transcript: 'trailing words',
            segments: [{ text: 'trailing words', start_time: 0, end_time: 1 }],
          }),
        );
        socket.send(JSON.stringify({ type: 'end_audio', body: { status: 'finished' } }));
      });
    });
    const { stream } = startStream();
    stream.pushFrame(samples(768));
    stream.endInput();
    const events: stt.SpeechEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(audioBytes).toBe(768 * 2);
    expect(textMessages).toEqual([{ type: 'end_audio' }]);
    expect(
      events
        .filter((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)
        .map((event) => event.alternatives?.[0]?.text),
    ).toEqual(['trailing words']);
  });

  it('delivers a final transcript more than five seconds after end_audio is acknowledged', async () => {
    await startServer();
    server.on('connection', (socket) => {
      let metadataReceived = false;
      socket.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(raw.toString());
        if (!metadataReceived) {
          metadataReceived = true;
          return;
        }
        if (message.type !== 'end_audio') return;
        socket.send(JSON.stringify({ type: 'end_audio', body: { status: 'acknowledged' } }));
        setTimeout(() => {
          socket.send(
            JSON.stringify({ type: 'transcription', is_final: true, transcript: 'trailing words' }),
          );
          socket.send(JSON.stringify({ type: 'end_audio', body: { status: 'finished' } }));
        }, 5_500);
      });
    });
    const { stream } = startStream(0, 9_000);
    stream.pushFrame(frame(0));
    stream.endInput();
    const events: stt.SpeechEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(events.some((event) => event.alternatives?.[0]?.text === 'trailing words')).toBe(true);
  }, 10_000);

  it('completes when the server ignores end_audio', async () => {
    await startServer();
    const textMessages: unknown[] = [];
    server.on('connection', (socket) => {
      let metadataReceived = false;
      socket.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(raw.toString());
        if (!metadataReceived) metadataReceived = true;
        else textMessages.push(message);
      });
    });
    const { stream } = startStream();
    stream.pushFrame(frame(0));
    stream.endInput();
    await drain(stream);

    expect(textMessages).toEqual([{ type: 'end_audio' }]);
    expect(stream.terminalError).toBeUndefined();
  }, 10_000);

  it('reports a close before finished without retrying', async () => {
    await startServer();
    let connections = 0;
    server.on('connection', (socket) => {
      connections++;
      let metadataReceived = false;
      socket.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(raw.toString());
        if (!metadataReceived) {
          metadataReceived = true;
          return;
        }
        if (message.type !== 'end_audio') return;
        socket.send(JSON.stringify({ type: 'end_audio', body: { status: 'acknowledged' } }));
        socket.close();
      });
    });
    const { stream } = startStream(3);
    stream.pushFrame(frame(0));
    stream.endInput();
    await drain(stream);

    expect(stream.terminalError).toBeInstanceOf(APIStatusError);
    expect(connections).toBe(1);
  });

  it('times out an acknowledged flush that never finishes without retrying', async () => {
    await startServer();
    let connections = 0;
    server.on('connection', (socket) => {
      connections++;
      let metadataReceived = false;
      socket.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(raw.toString());
        if (!metadataReceived) {
          metadataReceived = true;
          return;
        }
        if (message.type === 'end_audio') {
          socket.send(JSON.stringify({ type: 'end_audio', body: { status: 'acknowledged' } }));
        }
      });
    });
    const { stream } = startStream(3);
    stream.pushFrame(frame(0));
    stream.endInput();
    await drain(stream);

    expect(stream.terminalError).toBeInstanceOf(APITimeoutError);
    expect(connections).toBe(1);
  });
});
