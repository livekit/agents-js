// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WsModule from 'ws';
import { type ClientOptions, WebSocketServer } from 'ws';
import { STT } from './stt.js';

// Point every xAI socket at the local server started by each test.
let serverUrl = '';
const clients: WsModule.WebSocket[] = [];
vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof WsModule>();
  class LocalWebSocket extends actual.WebSocket {
    constructor(_url: string | URL, options?: ClientOptions) {
      super(serverUrl, options);
      clients.push(this);
    }
  }
  return { ...actual, WebSocket: LocalWebSocket };
});

initializeLogger({ pretty: false, level: 'silent' });

describe('xAI STT reconnect', () => {
  let wss: WebSocketServer;

  beforeEach(async () => {
    clients.length = 0;
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const { port } = wss.address() as { port: number };
    serverUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('reconnects when the socket drops mid-stream', async () => {
    let connections = 0;
    wss.on('connection', (ws) => {
      const n = ++connections;
      // give the client a moment to attach its listener, as a real server would
      setTimeout(() => ws.send(JSON.stringify({ type: 'transcript.created' })), 50);
      ws.once('message', () => {
        if (n === 1) {
          // drop the first connection as soon as audio arrives
          ws.terminate();
        } else {
          ws.send(JSON.stringify({ type: 'transcript.done', text: 'hello again' }));
        }
      });
    });

    const stream = new STT({ apiKey: 'dummy' }).stream();
    const feeder = setInterval(() => {
      stream.pushFrame(new AudioFrame(new Int16Array(1600), 16000, 1, 1600));
    }, 20);

    try {
      const final = (async () => {
        for await (const event of stream) {
          if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) return event;
        }
      })();
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('stream never recovered')), 4000),
      );
      const event = await Promise.race([final, timeout]);

      expect(event?.alternatives?.[0]?.text).toBe('hello again');
      expect(connections).toBe(2);
      // the dropped attempt's listener is gone, so late frames from it cannot
      // reach the reconnected stream
      expect(clients[0]!.listenerCount('message')).toBe(0);
    } finally {
      clearInterval(feeder);
      stream.close();
    }
  });
});
