// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, tts } from '@livekit/agents';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ws from 'ws';
import { type ClientOptions, type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const endpoint = vi.hoisted(() => ({ url: '' }));
vi.mock('ws', async (importOriginal) => {
  const original = await importOriginal<typeof ws>();
  return {
    ...original,
    WebSocket: class extends original.WebSocket {
      constructor(_url: string, options: ClientOptions) {
        super(endpoint.url, options);
      }
    },
  };
});

// 100 ms of 16-bit mono PCM at the default 44.1 kHz.
const AUDIO = Buffer.alloc(8820).toString('base64');

type Connection = (ws: WebSocket, request: { request_id: number; data: string }) => void;

let wss: WebSocketServer | undefined;

/** Starts a Resemble stand-in that handles connection N with `connections[N]`. */
async function startServer(
  connections: Connection[],
  rejectHandshakes = 0,
  rejectionStatus = 503,
): Promise<{ handshakes: () => number; texts: string[][] }> {
  let handshakes = 0;
  const texts: string[][] = [];
  wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (_info, done) => {
      handshakes++;
      if (handshakes <= rejectHandshakes) done(false, rejectionStatus);
      else done(true);
    },
  });
  wss.on('connection', (ws) => {
    const handle = connections[texts.length]!;
    const received: string[] = [];
    texts.push(received);
    ws.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as { request_id: number; data: string };
      received.push(request.data.trim());
      handle(ws, request);
    });
  });
  await once(wss, 'listening');
  endpoint.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return { handshakes: () => handshakes, texts };
}

const respond: Connection = (ws, { request_id }) => {
  ws.send(JSON.stringify({ request_id, audio_content: AUDIO }));
  ws.send(JSON.stringify({ request_id, type: 'audio_end' }));
};

async function synthesize(provider: TTS, text: string) {
  const stream = provider.stream();
  const audio: tts.SynthesizedAudio[] = [];
  try {
    stream.pushText(text);
    stream.endInput();
    for await (const event of stream) {
      if (event !== tts.SynthesizeStream.END_OF_STREAM) audio.push(event);
    }
  } finally {
    stream.close();
  }
  return audio;
}

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(async () => {
  for (const client of wss?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  wss = undefined;
});

describe('Resemble SynthesizeStream retries', () => {
  const text = 'Please read this whole sentence before any audio arrives.';

  it('retries a rejected handshake and returns the retry audio', async () => {
    const server = await startServer([respond], 1);
    const provider = new TTS({ apiKey: 'test-key' });
    const errors: { recoverable: boolean }[] = [];
    provider.on('error', (error) => errors.push(error));

    const audio = await synthesize(provider, text);

    expect(server.handshakes()).toBe(2);
    expect(server.texts).toEqual([[text]]);
    expect(audio.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('does not retry a rejected handshake when the credentials are invalid', async () => {
    const server = await startServer([respond], 1, 401);
    const provider = new TTS({ apiKey: 'test-key' });
    const errors: unknown[] = [];
    provider.on('error', (error) => errors.push(error));

    expect(await synthesize(provider, text)).toEqual([]);
    expect(server.handshakes()).toBe(1);
    expect(errors).toEqual([expect.objectContaining({ recoverable: false })]);
  });

  it('retries a socket that closes before audio instead of ending the stream', async () => {
    const server = await startServer([(ws) => ws.close(1011), respond]);
    const provider = new TTS({ apiKey: 'test-key' });
    const errors: { recoverable: boolean }[] = [];
    provider.on('error', (error) => errors.push(error));

    const audio = await synthesize(provider, text);

    expect(server.texts).toEqual([[text], [text]]);
    expect(audio.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('fails without a retry when the socket closes after audio', async () => {
    const server = await startServer([
      (ws, { request_id }) => {
        ws.send(JSON.stringify({ request_id, audio_content: AUDIO }));
        ws.send(JSON.stringify({ request_id, audio_content: AUDIO }), () => ws.close(1011));
      },
      respond,
    ]);
    const provider = new TTS({ apiKey: 'test-key' });
    const errors: { recoverable: boolean }[] = [];
    provider.on('error', (error) => errors.push(error));

    const audio = await synthesize(provider, text);

    expect(server.texts).toEqual([[text]]);
    expect(audio.length).toBeGreaterThan(0);
    expect(errors.map((error) => error.recoverable)).toEqual([false]);
  });

  it('neither retries nor reports an error when the stream is closed mid-request', async () => {
    let received!: () => void;
    const requested = new Promise<void>((resolve) => (received = resolve));
    const server = await startServer([() => received(), respond]);
    const provider = new TTS({ apiKey: 'test-key' });
    const errors: { recoverable: boolean }[] = [];
    provider.on('error', (error) => errors.push(error));
    const stream = provider.stream();
    stream.pushText(text);
    stream.endInput();

    await requested;
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.texts).toEqual([[text]]);
    expect(errors).toEqual([]);
  });
});
