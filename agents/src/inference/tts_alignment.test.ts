// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { SynthesizeStream } from '../tts/tts.js';
import { TTS } from './tts.js';

it('adds separators to Cartesia inference word timestamps', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string };
      if (event.type !== 'session.flush') return;

      socket.send(
        JSON.stringify({
          type: 'output_alignment',
          session_id: 'session-1',
          words: [
            { word: 'hello', start: 0, end: 0.2 },
            { word: 'world.', start: 0.2, end: 0.4 },
          ],
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'output_audio',
          session_id: 'session-1',
          audio: Buffer.alloc(3200).toString('base64'),
        }),
      );
      socket.send(JSON.stringify({ type: 'done', session_id: 'session-1' }));
    });
  });

  const tts = new TTS({
    model: 'cartesia/sonic-3',
    modelOptions: { add_timestamps: true },
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: `http://127.0.0.1:${address.port}`,
  });

  try {
    const stream = tts.stream();
    stream.pushText('hello world.');
    stream.endInput();

    const words: string[] = [];
    for await (const event of stream) {
      if (event !== SynthesizeStream.END_OF_STREAM) {
        words.push(...(event.timedTranscripts ?? []).map((word) => word.text));
      }
    }

    expect(words).toEqual(['hello ', 'world. ']);
  } finally {
    await tts.close();
    for (const client of server.clients) client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('keeps the stream model and markup dialect after a model update', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const packets: Array<{
    type: string;
    transcript?: string;
    generation_config?: { model?: string };
  }> = [];

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as (typeof packets)[number];
      packets.push(event);
      if (event.type !== 'session.flush') return;
      socket.send(
        JSON.stringify({
          type: 'output_audio',
          session_id: 'session-1',
          audio: Buffer.alloc(4800).toString('base64'),
        }),
      );
      socket.send(JSON.stringify({ type: 'done', session_id: 'session-1' }));
    });
  });

  const tts = new TTS({
    model: 'fishaudio/s2.1-pro',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: `http://127.0.0.1:${address.port}`,
  });
  tts._setExpressive(true);

  try {
    const stream = tts.stream();
    tts.updateOptions({ model: 'fishaudio/drama-3' });
    stream.pushText('<expr type="expression" label="sad"/> Sorry about that.');
    stream.endInput();
    for await (const _event of stream) {
      // drain the stream
    }

    const transcripts = packets.filter((packet) => packet.type === 'input_transcript');
    expect(transcripts.map((packet) => packet.transcript)).toEqual([
      '[very sad] Sorry about that. ',
    ]);
    expect(transcripts[0]?.generation_config?.model).toBe('fishaudio/s2.1-pro');
  } finally {
    await tts.close();
    for (const client of server.clients) client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
