// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, APIConnectionError, initializeLogger, tts } from '@livekit/agents';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ws from 'ws';
import { type ClientOptions, type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const endpoint = vi.hoisted(() => ({ url: '', coalesced: undefined as string | undefined }));
vi.mock('ws', async (importOriginal) => {
  const original = await importOriginal<typeof ws>();
  return {
    ...original,
    WebSocket: class extends original.WebSocket {
      constructor(_url: string, options: ClientOptions) {
        super(endpoint.url, options);
      }

      /** Emits `endpoint.coalesced` in the same turn as the next message, as one socket read. */
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const handled = super.emit(event, ...args);
        if (event === 'message' && endpoint.coalesced !== undefined) {
          const next = Buffer.from(endpoint.coalesced);
          endpoint.coalesced = undefined;
          super.emit('message', next, false);
        }
        return handled;
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
  {
    rejectHandshakes = 0,
    rejectionStatus = 503,
    firstHandshakeDelayMs = 0,
  }: { rejectHandshakes?: number; rejectionStatus?: number; firstHandshakeDelayMs?: number } = {},
): Promise<{ handshakes: () => number; texts: string[][] }> {
  let handshakes = 0;
  const texts: string[][] = [];
  wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }, done) => {
      handshakes++;
      if (handshakes === 1 && firstHandshakeDelayMs > 0) {
        const timer = setTimeout(() => done(true), firstHandshakeDelayMs);
        req.socket.once('close', () => clearTimeout(timer));
        return;
      }
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

async function synthesize(provider: TTS, text: string, connOptions?: APIConnectOptions) {
  const stream = provider.stream({ connOptions });
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
  endpoint.coalesced = undefined;
  for (const client of wss?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  wss = undefined;
});

describe('Resemble SynthesizeStream retries', () => {
  const text = 'Please read this whole sentence before any audio arrives.';

  it('retries a rejected handshake and returns the retry audio', async () => {
    const server = await startServer([respond], { rejectHandshakes: 1 });
    const provider = new TTS({ apiKey: 'test-key' });
    const errors: { recoverable: boolean }[] = [];
    provider.on('error', (error) => errors.push(error));

    const audio = await synthesize(provider, text);

    expect(server.handshakes()).toBe(2);
    expect(server.texts).toEqual([[text]]);
    expect(audio.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('retries when the WebSocket handshake exceeds the configured deadline', async () => {
    const server = await startServer([respond], { firstHandshakeDelayMs: 750 });
    const provider = new TTS({ apiKey: 'test-key' });
    const errors: unknown[] = [];
    provider.on('error', (error) => errors.push(error));

    const audio = await synthesize(provider, text, {
      maxRetry: 1,
      retryIntervalMs: 0,
      timeoutMs: 150,
    });

    expect(server.handshakes()).toBe(2);
    expect(server.texts).toEqual([[text]]);
    expect(audio.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it('does not retry a transient handshake failure with maxRetry set to zero', async () => {
    const server = await startServer([respond], { rejectHandshakes: 1 });
    const provider = new TTS({ apiKey: 'test-key' });
    const errors: unknown[] = [];
    provider.on('error', (error) => errors.push(error));

    const audio = await synthesize(provider, text, {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 1000,
    });

    expect(server.handshakes()).toBe(1);
    expect(audio).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ recoverable: false })]);
  });

  it('does not retry a rejected handshake when the credentials are invalid', async () => {
    const server = await startServer([respond], { rejectHandshakes: 1, rejectionStatus: 401 });
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

  it.each(['open', 'ended'] as const)(
    'reports a provider error read together with audio, with %s input',
    async (input) => {
      const server = await startServer([
        (ws, { request_id }) => ws.send(JSON.stringify({ request_id, audio_content: AUDIO })),
        respond,
      ]);
      endpoint.coalesced = JSON.stringify({ success: false, error_name: 'InvalidVoice' });
      const provider = new TTS({ apiKey: 'test-key' });
      const errors: { error: Error; recoverable: boolean }[] = [];
      provider.on('error', (error) => errors.push(error));
      const stream = provider.stream();
      try {
        stream.pushText(text);
        if (input === 'ended') stream.endInput();
        else stream.flush();
        for await (const _event of stream) {
          // Drain until the failure closes the output.
        }

        expect(server.texts).toEqual([[text]]);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.recoverable).toBe(false);
        expect(errors[0]!.error.message).toBe('Resemble API error: InvalidVoice');
        expect(errors[0]!.error).not.toBeInstanceOf(APIConnectionError);
        expect(stream.error).toBe(errors[0]!.error);
      } finally {
        stream.close();
      }
    },
  );
});
