// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, tokenize } from '@livekit/agents';
import { once } from 'node:events';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { TTS, type TTSOptions } from './tts.js';

type Message = Record<string, Record<string, unknown> | string>;

let server: WebSocketServer | undefined;
let provider: TTS | undefined;

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  if (server) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

// Runs one stream against a fake Inworld server and returns the messages it received.
async function synthesize(opts: Partial<TTSOptions>, input: string[]): Promise<Message[]> {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');

  const received: Message[] = [];
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Message;
      received.push(msg);
      if ('close_context' in msg) {
        const contextId = msg.contextId;
        const audioContent = Buffer.alloc(4800).toString('base64');
        socket.send(JSON.stringify({ result: { contextId, audioChunk: { audioContent } } }));
        socket.send(JSON.stringify({ result: { contextId, contextClosed: {} } }));
      }
    });
  });

  provider = new TTS({ apiKey: 'test', wsURL: `ws://127.0.0.1:${address.port}/`, ...opts });
  const stream = provider.stream();
  for (const text of input) stream.pushText(text);
  stream.endInput();
  for await (const _ of stream) {
    /* drain */
  }
  return received;
}

const tokens = ['Hello', ' there.', ' How', ' are', ' you?'];

describe('Inworld auto mode strategy', () => {
  it('streams raw text with SENTENCE_BOUNDARY on inworld-tts-2', async () => {
    const received = await synthesize({ model: 'inworld-tts-2' }, tokens);

    const create = received[0]!.create as Record<string, unknown>;
    expect(create.autoMode).toBe(true);
    expect(create.autoModeStrategy).toBe('SENTENCE_BOUNDARY');
    expect(create).not.toHaveProperty('bufferCharThreshold');
    expect(received.slice(1).map((m) => Object.keys(m)[0])).toEqual([
      ...tokens.map(() => 'send_text'),
      'flush_context',
      'close_context',
    ]);
    expect(received.slice(1, 6).map((m) => (m.send_text as { text: string }).text)).toEqual(tokens);
  });

  it('keeps client segmentation with a custom tokenizer', async () => {
    const received = await synthesize(
      {
        model: 'inworld-tts-2',
        tokenizer: new tokenize.basic.SentenceTokenizer({ minSentenceLength: 1 }),
      },
      tokens,
    );

    expect(received[0]!.create).not.toHaveProperty('autoModeStrategy');
    expect(received[0]!.create).toHaveProperty('bufferCharThreshold', 250);
    const texts = received.filter((m) => 'send_text' in m);
    expect(texts.length).toBeLessThan(tokens.length);
  });

  it('sends a set bufferCharThreshold with SENTENCE_BOUNDARY', async () => {
    const received = await synthesize({ model: 'inworld-tts-2', bufferCharThreshold: 400 }, tokens);

    expect(received[0]!.create).toHaveProperty('autoModeStrategy', 'SENTENCE_BOUNDARY');
    expect(received[0]!.create).toHaveProperty('bufferCharThreshold', 400);
  });

  it('keeps client segmentation on models without sentence boundary support', async () => {
    const received = await synthesize({ model: 'inworld-tts-1.5-max' }, tokens);

    expect(received[0]!.create).not.toHaveProperty('autoModeStrategy');
  });
});
