// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
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

describe('Deepgram v1 dead socket recovery', () => {
  const FAST_CONN_OPTIONS = { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 1000 };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  function frameOf(value: number, samples = 1600) {
    return new AudioFrame(new Int16Array(samples).fill(value), 16000, 1, samples);
  }

  function resultsMessage(opts: {
    text: string;
    isFinal: boolean;
    speechFinal?: boolean;
    start: number;
    duration: number;
  }) {
    return JSON.stringify({
      type: 'Results',
      is_final: opts.isFinal,
      speech_final: opts.speechFinal ?? false,
      start: opts.start,
      duration: opts.duration,
      metadata: { request_id: 'req' },
      channel: {
        alternatives: [
          {
            transcript: opts.text,
            confidence: 0.9,
            words: opts.text
              ? [{ word: opts.text, start: opts.start, end: opts.start + opts.duration }]
              : [],
          },
        ],
      },
    });
  }

  function collectEvents(s: stt.SpeechStream) {
    const events: stt.SpeechEvent[] = [];
    (async () => {
      for await (const event of s) events.push(event);
    })().catch(() => {});
    return events;
  }

  function recordConnections() {
    const sockets: WebSocket[] = [];
    const audio: number[][] = [];
    server.on('connection', (socket) => {
      const index = sockets.push(socket) - 1;
      audio[index] = [];
      socket.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const pcm = new Int16Array(
          (data as Buffer).buffer,
          (data as Buffer).byteOffset,
          (data as Buffer).byteLength / 2,
        );
        audio[index]!.push(...pcm);
      });
    });
    return { sockets, audio };
  }

  const typesOf = (events: stt.SpeechEvent[]) =>
    events.filter((e) => e.type !== stt.SpeechEventType.RECOGNITION_USAGE).map((e) => e.type);

  it('does not redial when usage is reported after the event queue closed', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    (stream as unknown as { queue: { close(): void } }).queue.close();
    stream.pushFrame(frameOf(1));
    stream.flush();
    await sleep(100);

    expect(sockets).toHaveLength(1);
  });

  it('commits the open turn and starts the next one when the socket drops mid-turn', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    const events = collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    sockets[0]!.send(resultsMessage({ text: 'hello', isFinal: false, start: 0, duration: 0.5 }));
    await vi.waitFor(() => expect(typesOf(events)).toHaveLength(2));
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    expect(typesOf(events)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    const final = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(final?.alternatives?.[0]?.text).toBe('hello');

    sockets[1]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    await vi.waitFor(() => expect(typesOf(events)).toHaveLength(5));
    expect(typesOf(events)[4]).toBe(stt.SpeechEventType.START_OF_SPEECH);
  });

  it('replays the audio Deepgram had not transcribed to the next socket', async () => {
    const baseUrl = await startServer();
    const { sockets, audio } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    for (const value of [1, 2, 3, 4, 5]) stream.pushFrame(frameOf(value));
    await vi.waitFor(() => expect(audio[0]).toHaveLength(5 * 1600));

    // transcribed up to 0.2 s: the first two frames are acknowledged, the other three are owed
    sockets[0]!.send(resultsMessage({ text: '', isFinal: true, start: 0, duration: 0.2 }));
    await sleep(50);
    sockets[0]!.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    stream.pushFrame(frameOf(6));
    const owed = [3, 4, 5, 6].flatMap((value) => new Array<number>(1600).fill(value));
    await vi.waitFor(() => expect(audio[1]).toHaveLength(owed.length));
    expect(audio[1]).toEqual(owed);
  });

  it('commits a turn that stalls on a socket that is still answering', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: 100 });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    const events = collectEvents(stream);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]!.send(JSON.stringify({ type: 'SpeechStarted' }));
    sockets[0]!.send(resultsMessage({ text: 'hello', isFinal: false, start: 0, duration: 0.5 }));

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(typesOf(events)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
  });

  it('does not treat silence between turns as a stall', async () => {
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl, turnStallTimeoutMs: 50 });
    stream = provider.stream({ connOptions: FAST_CONN_OPTIONS });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await sleep(200);

    expect(sockets).toHaveLength(1);
  });

  it('gives up with a non-retryable error when sockets keep dropping without a finished turn', async () => {
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
      schedule(callback, ms === 5000 || ms === 10000 ? 0 : ms, ...args),
    );
    const baseUrl = await startServer();
    let connections = 0;
    server.on('connection', (socket) => {
      connections += 1;
      socket.close(1011);
    });
    const provider = new STT({ apiKey: 'test', baseUrl });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    for await (const _ of stream) {
      /* drain */
    }

    expect(connections).toBe(2);
    expect(stream.terminalError).toBeInstanceOf(APIConnectionError);
  });

  it('counts only drops since the last finished turn toward the budget', async () => {
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
      schedule(callback, ms === 5000 || ms === 10000 ? 0 : ms, ...args),
    );
    const baseUrl = await startServer();
    const { sockets } = recordConnections();
    const provider = new STT({ apiKey: 'test', baseUrl });
    provider.on('error', vi.fn());
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    collectEvents(stream);

    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(sockets).toHaveLength(i + 1));
      sockets[i]!.send(JSON.stringify({ type: 'SpeechStarted' }));
      sockets[i]!.send(
        resultsMessage({ text: 'hi', isFinal: true, speechFinal: true, start: 0, duration: 0.5 }),
      );
      await sleep(30);
      sockets[i]!.terminate();
    }
    await vi.waitFor(() => expect(sockets).toHaveLength(5));
    expect(stream.terminalError).toBeUndefined();
  });
});
