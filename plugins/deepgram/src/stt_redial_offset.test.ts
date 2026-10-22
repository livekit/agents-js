// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ServerOptions, type WebSocket, WebSocketServer } from 'ws';
import { STT } from './stt.js';

const SAMPLE_RATE = 16000;
const FRAME_MS = 100;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;
const FRAMES_BEFORE_DROP = 10; // one second of audio on the first socket
const BYTES_BEFORE_DROP = FRAMES_BEFORE_DROP * SAMPLES_PER_FRAME * 2;

let server: WebSocketServer;
let stream: stt.SpeechStream | undefined;

async function startServer(options: ServerOptions = {}) {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP server');
  return `ws://127.0.0.1:${address.port}`;
}

function results(transcript: string, start: number, end: number) {
  return JSON.stringify({
    type: 'Results',
    is_final: true,
    speech_final: true,
    metadata: { request_id: 'r2' },
    channel: {
      alternatives: [
        {
          transcript,
          confidence: 1,
          words: [{ word: transcript, punctuated_word: transcript, start, end, confidence: 1 }],
        },
      ],
    },
  });
}

const frame = () =>
  new AudioFrame(new Int16Array(SAMPLES_PER_FRAME), SAMPLE_RATE, 1, SAMPLES_PER_FRAME);

/** Deepgram's clock on this socket runs over the audio it was sent; drop it abnormally once a second has arrived. */
function dropAfterOneSecond(socket: WebSocket) {
  let received = 0;
  socket.on('message', (data, isBinary) => {
    if (!isBinary) return;
    received += (data as Buffer).length;
    if (received >= BYTES_BEFORE_DROP) socket.close(1011);
  });
}

/** Answer the first audio the socket carries rather than the handshake, so the client is listening. */
function answerFirstAudio(socket: WebSocket, body: string) {
  socket.once('message', () => socket.send(body));
}

async function firstFinal(speech: stt.SpeechStream): Promise<stt.SpeechEvent | undefined> {
  for await (const event of speech) {
    if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) return event;
  }
  return undefined;
}

afterEach(async () => {
  vi.useRealTimers();
  stream?.close();
  for (const socket of server?.clients ?? []) socket.terminate();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Deepgram STT reopened socket', () => {
  it('advances startTimeOffset by the audio the dropped socket received', async () => {
    const baseUrl = await startServer();
    let connections = 0;
    let redialed: () => void = () => {};
    const secondSocket = new Promise<void>((resolve) => (redialed = resolve));
    server.on('connection', (socket: WebSocket) => {
      connections += 1;
      if (connections === 1) {
        dropAfterOneSecond(socket);
        return;
      }
      // The replacement socket's clock starts at 0 again.
      answerFirstAudio(socket, results('hello', 0, 0.5));
      redialed();
    });

    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream();
    for (let i = 0; i < FRAMES_BEFORE_DROP; i++) stream.pushFrame(frame());
    await secondSocket;
    stream.pushFrame(frame());

    const final = await firstFinal(stream);

    expect(connections).toBe(2);
    expect(final?.alternatives?.[0].startTime).toBeCloseTo(1.0, 5);
    expect(final?.alternatives?.[0].endTime).toBeCloseTo(1.5, 5);
  });

  it('hands the offset back to the base retry when an error escapes run()', async () => {
    // Date pinned: the base class adds wall-clock elapsed on its own retry, and
    // what this pins is that nothing of the plugin's audio-based addition is
    // left on top of it once run() has thrown.
    vi.useFakeTimers({ toFake: ['Date'] });
    let handshakes = 0;
    const baseUrl = await startServer({
      // The redial after the drop is refused with a retryable status, so run()
      // rethrows and SpeechStream.mainTask dials again.
      verifyClient: (_info, done) => done(++handshakes !== 2, 503),
    });
    let connections = 0;
    let recovered: () => void = () => {};
    const thirdSocket = new Promise<void>((resolve) => (recovered = resolve));
    server.on('connection', (socket: WebSocket) => {
      connections += 1;
      if (connections === 1) {
        dropAfterOneSecond(socket);
        return;
      }
      answerFirstAudio(socket, results('hello', 0, 0.5));
      recovered();
    });

    const provider = new STT({ apiKey: 'test', baseUrl });
    provider.on('error', () => {});
    stream = provider.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 } });
    for (let i = 0; i < FRAMES_BEFORE_DROP; i++) stream.pushFrame(frame());
    await thirdSocket;
    stream.pushFrame(frame());

    const final = await firstFinal(stream);

    expect(handshakes).toBe(3);
    expect(connections).toBe(2);
    expect(final?.alternatives?.[0].startTime).toBeCloseTo(0, 5);
  });

  it('stamps a socket’s results with the offset as of its open, not a later value', async () => {
    // The dial loop advances the shared offset as soon as a reset socket's
    // #runWS returns, while that socket's final results may still be on the
    // wire; those results belong to the clock the socket was opened on.
    const baseUrl = await startServer();
    let gotAudio: (socket: WebSocket) => void = () => {};
    const audioReceived = new Promise<WebSocket>((resolve) => (gotAudio = resolve));
    server.on('connection', (socket: WebSocket) => {
      let received = 0;
      socket.on('message', (data, isBinary) => {
        if (!isBinary) return;
        received += (data as Buffer).length;
        if (received >= BYTES_BEFORE_DROP) gotAudio(socket);
      });
    });

    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream();
    for (let i = 0; i < FRAMES_BEFORE_DROP; i++) stream.pushFrame(frame());
    const socket = await audioReceived;
    stream.startTimeOffset = 5;
    socket.send(results('late', 0, 0.5));

    const final = await firstFinal(stream);

    expect(final?.alternatives?.[0].text).toBe('late');
    expect(final?.alternatives?.[0].startTime).toBeCloseTo(0, 5);
  });
});
