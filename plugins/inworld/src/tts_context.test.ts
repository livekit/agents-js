// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { EventEmitter, once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ws from 'ws';
import { TTS } from './tts.js';

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

type Message = { contextId: string } & Record<string, unknown>;

let server: ws.WebSocketServer;
let received: Message[];
const events = new EventEmitter();

function kinds() {
  return received.map((m) => Object.keys(m).find((k) => k !== 'contextId'));
}

async function waitFor(kind: string) {
  while (!kinds().includes(kind)) await once(events, 'message');
}

async function startServer({ answerClose }: { answerClose: boolean }) {
  received = [];
  server = new ws.WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Message;
      received.push(msg);
      events.emit('message');
      const reply = (result: object) =>
        socket.send(JSON.stringify({ result: { contextId: msg.contextId, ...result } }));
      if ('create' in msg) reply({ contextCreated: {} });
      if ('cancel_context' in msg || ('close_context' in msg && answerClose)) {
        reply({ contextClosed: {} });
      }
    });
  });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');
  endpoint.url = `ws://127.0.0.1:${address.port}`;
}

function startStream() {
  const provider = new TTS({ apiKey: 'test', wsURL: endpoint.url });
  return provider.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 } });
}

beforeEach(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type SendCallback = (err?: Error) => void;

// Holds the client's send callback for the first payload of `kind`, so a test can
// settle that send after closing the stream.
function holdSend(kind: string, forward: boolean) {
  const original = ws.WebSocket.prototype.send;
  let release!: (cb: SendCallback) => void;
  const held = new Promise<SendCallback>((resolve) => (release = resolve));
  let holding = true;
  vi.spyOn(ws.WebSocket.prototype, 'send').mockImplementation(function (
    this: ws.WebSocket,
    data: unknown,
    ...rest: unknown[]
  ) {
    const cb = rest.find((r): r is SendCallback => typeof r === 'function');
    if (holding && cb && String(data).includes(`"${kind}"`)) {
      holding = false;
      if (forward) original.call(this, data as string);
      release(cb);
      return;
    }
    return (original as (...args: unknown[]) => void).call(this, data, ...rest);
  });
  return held;
}

describe('inworld TTS context lifecycle', () => {
  it('closes the context when the input ends', async () => {
    await startServer({ answerClose: true });
    const stream = startStream();
    stream.pushText('Hello there.');
    stream.endInput();
    for await (const _ of stream) {
      /* drain */
    }

    expect(kinds()).toEqual(['create', 'send_text', 'flush_context', 'close_context']);
  });

  it('cancels the context when the stream is closed mid-reply', async () => {
    await startServer({ answerClose: true });
    const stream = startStream();
    stream.pushText('Hello there. How are you doing today? ');
    stream.flush();
    await waitFor('send_text');
    stream.close();
    await waitFor('cancel_context');

    expect(kinds()).not.toContain('close_context');
    expect(new Set(received.map((m) => m.contextId)).size).toBe(1);
  });

  it('cancels a closing context when the stream is closed', async () => {
    await startServer({ answerClose: false });
    const stream = startStream();
    stream.pushText('Hello there. How are you doing today?');
    stream.endInput();
    await waitFor('close_context');
    stream.close();
    await waitFor('cancel_context');

    expect(kinds().slice(-2)).toEqual(['close_context', 'cancel_context']);
  });

  it('cancels without closing when the stream is closed during the flush', async () => {
    await startServer({ answerClose: false });
    const flushSent = holdSend('flush_context', true);
    const stream = startStream();
    stream.pushText('Hello there. How are you doing today?');
    stream.endInput();
    const settleFlush = await flushSent;
    stream.close();
    settleFlush();
    await waitFor('cancel_context');

    expect(kinds()).toContain('flush_context');
    expect(kinds()).not.toContain('close_context');
  });

  it('ignores a text send that fails after the stream is closed', async () => {
    await startServer({ answerClose: true });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const textSent = holdSend('send_text', false);
      const stream = startStream();
      stream.pushText('Hello there. How are you doing today? ');
      stream.flush();
      const failText = await textSent;
      stream.close();
      await waitFor('cancel_context');
      failText(new Error('send failed'));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
