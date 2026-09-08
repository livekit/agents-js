// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIError, tts } from '@livekit/agents';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const servers: WebSocketServer[] = [];
const clients: TTS[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.clients.forEach((socket) => socket.terminate());
          server.close(() => resolve());
        }),
    ),
  );
});

async function server(mode = 'normal') {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const urls: string[] = [];
  server.on('connection', (socket, request) => {
    urls.push(request.url!);
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString());
      if (event.text) {
        if (mode === 'error') {
          socket.send(JSON.stringify({ type: 'error', message: 'secret provider text' }));
          return;
        }
        if (mode === 'close') {
          socket.close(1011, 'secret close reason');
          return;
        }
        if (mode === 'invalid') {
          socket.send('secret invalid JSON');
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'timestamps',
            word_timestamps: { words: ['Hello'], start: [0], end: [0.1] },
          }),
        );
        socket.send(JSON.stringify({ type: 'chunk', data: Buffer.alloc(4800).toString('base64') }));
      }
      if (event.operation === 'flush') socket.send(JSON.stringify({ type: 'done' }));
    });
  });
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, urls };
}

it('preserves WS3 timestamps and reuses its connection', async () => {
  const peer = await server();
  const value = new TTS({ apiKey: 'key', baseURL: peer.url });
  clients.push(value);
  const errors: APIError[] = [];
  value.on('error', (event) => errors.push(event.error as APIError));
  for (let i = 0; i < 2; i++) {
    const stream = value.stream({
      connOptions: { maxRetry: 0, timeoutMs: 500, retryIntervalMs: 0 },
    });
    stream.pushText('Hello.');
    stream.endInput();
    const frames: tts.SynthesizedAudio[] = [];
    for await (const frame of stream)
      if (frame !== tts.SynthesizeStream.END_OF_STREAM) frames.push(frame);
    expect(frames.flatMap((frame) => frame.timedTranscripts ?? [])).toHaveLength(1);
    expect(frames.at(-1)?.final).toBe(true);
  }
  expect(errors).toEqual([]);
  expect(peer.urls).toHaveLength(1);
  expect(new URL(peer.urls[0]!, peer.url).pathname).toBe('/ws3');
});

it('keeps existing WS3 streams bound to their original options', async () => {
  const peer = await server();
  const value = new TTS({ apiKey: 'key', baseURL: peer.url, speaker: 'original' });
  clients.push(value);
  value.on('error', () => {});
  const old = value.stream();
  value.updateOptions({ speaker: 'updated', samplingRate: 16000 });
  old.pushText('Hello.');
  old.endInput();
  for await (const frame of old)
    if (frame !== tts.SynthesizeStream.END_OF_STREAM) expect(frame.frame.sampleRate).toBe(24000);
  const next = value.stream();
  next.pushText('Hello.');
  next.endInput();
  for await (const frame of next)
    if (frame !== tts.SynthesizeStream.END_OF_STREAM) expect(frame.frame.sampleRate).toBe(16000);
  expect(peer.urls).toHaveLength(2);
  expect(new URL(peer.urls[0]!, peer.url).searchParams.get('speaker')).toBe('original');
  expect(new URL(peer.urls[1]!, peer.url).searchParams.get('speaker')).toBe('updated');
});

it.each(['error', 'close', 'invalid'])(
  'sanitizes legacy %s events and closes the stream',
  async (mode) => {
    const peer = await server(mode);
    const value = new TTS({ apiKey: 'key', baseURL: peer.url });
    clients.push(value);
    const errors: APIError[] = [];
    value.on('error', (event) => errors.push(event.error as APIError));
    const stream = value.stream({
      connOptions: { maxRetry: 0, timeoutMs: 100, retryIntervalMs: 0 },
    });
    stream.pushText('Hello.');
    stream.endInput();
    for await (const _frame of stream) {
      /* drain */
    }
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(String(errors[0])).not.toContain('secret');
    expect(errors[0]!.cause).toBeUndefined();
  },
);
