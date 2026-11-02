// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, stt } from '@livekit/agents';
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
  it('reports the final word boundary on v1 speech end', async () => {
    const baseUrl = await startServer();
    server.on('connection', (socket) => {
      socket.once('pong', () => {
        socket.send(JSON.stringify({ type: 'SpeechStarted' }));
        socket.send(
          JSON.stringify({
            type: 'Results',
            is_final: true,
            speech_final: true,
            metadata: { request_id: 'one' },
            channel: {
              alternatives: [
                {
                  transcript: 'hello',
                  confidence: 1,
                  words: [{ word: 'hello', start: 0.1, end: 0.4, confidence: 1 }],
                },
              ],
            },
          }),
        );
      });
      socket.ping();
    });
    stream = new STT({ apiKey: 'test', baseUrl }).stream();
    stream.startTimeOffset = 7;
    for await (const event of stream) {
      if (event.type === stt.SpeechEventType.END_OF_SPEECH) {
        expect(event.alternatives?.[0]?.endTime).toBeCloseTo(7.4);
        break;
      }
    }
  });

  it('reports the final word rather than the Flux audio window end', async () => {
    const endpointUrl = await startServer();
    server.on('connection', (socket) => {
      socket.once('pong', () => {
        socket.send(
          JSON.stringify({
            type: 'TurnInfo',
            event: 'StartOfTurn',
            request_id: 'one',
            transcript: 'hello',
            audio_window_start: 0,
            audio_window_end: 1.5,
            words: [{ word: 'hello', start: 0.1, end: 0.4, confidence: 1 }],
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'TurnInfo',
            event: 'EndOfTurn',
            request_id: 'one',
            transcript: 'hello',
            audio_window_start: 0,
            audio_window_end: 1.5,
            words: [{ word: 'hello', start: 0.1, end: 0.4, confidence: 1 }],
          }),
        );
      });
      socket.ping();
    });
    stream = new STTv2({ apiKey: 'test', endpointUrl }).stream();
    stream.startTimeOffset = 7;
    for await (const event of stream) {
      if (event.type === stt.SpeechEventType.END_OF_SPEECH) {
        expect(event.alternatives?.[0]?.endTime).toBeCloseTo(7.4);
        break;
      }
    }
  });

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
