// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STT } from './stt.js';

const SAMPLE_RATE = 16000;
const FRAME_MS = 100;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;
const FRAMES_BEFORE_DROP = 10; // one second of audio on the first socket
const BYTES_BEFORE_DROP = FRAMES_BEFORE_DROP * SAMPLES_PER_FRAME * 2;

let server: WebSocketServer;
let stream: stt.SpeechStream | undefined;

async function startServer() {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
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

afterEach(async () => {
  stream?.close();
  for (const socket of server?.clients ?? []) socket.terminate();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Deepgram STT redial', () => {
  it('advances startTimeOffset by the audio the dropped socket received', async () => {
    const baseUrl = await startServer();
    let connections = 0;
    let redialed: () => void = () => {};
    const secondSocket = new Promise<void>((resolve) => (redialed = resolve));
    server.on('connection', (socket: WebSocket) => {
      connections += 1;
      if (connections === 1) {
        // Deepgram's clock on this socket runs over the audio it was sent; drop
        // it abnormally once a second of audio has arrived.
        let received = 0;
        socket.on('message', (data, isBinary) => {
          if (!isBinary) return;
          received += (data as Buffer).length;
          if (received >= BYTES_BEFORE_DROP) socket.close(1011);
        });
        return;
      }
      // The replacement socket's clock starts at 0 again. Answer the first audio
      // it carries rather than the handshake, so the client is listening.
      socket.once('message', () => socket.send(results('hello', 0, 0.5)));
      redialed();
    });

    const provider = new STT({ apiKey: 'test', baseUrl });
    stream = provider.stream();
    const data = new Int16Array(SAMPLES_PER_FRAME);
    const frame = () => new AudioFrame(data, SAMPLE_RATE, 1, SAMPLES_PER_FRAME);
    for (let i = 0; i < FRAMES_BEFORE_DROP; i++) {
      stream.pushFrame(frame());
    }
    await secondSocket;
    stream.pushFrame(frame());

    let final: stt.SpeechEvent | undefined;
    for await (const event of stream) {
      if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) {
        final = event;
        break;
      }
    }

    expect(connections).toBe(2);
    expect(final?.alternatives?.[0].startTime).toBeCloseTo(1.0, 5);
    expect(final?.alternatives?.[0].endTime).toBeCloseTo(1.5, 5);
  });
});
