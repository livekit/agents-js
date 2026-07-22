// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, tts } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const hasCartesiaConfig = Boolean(process.env.CARTESIA_API_KEY && process.env.OPENAI_API_KEY);

if (hasCartesiaConfig) {
  describe('Cartesia', async () => {
    await testTts(new TTS(), new STT());
  });
} else {
  describe('Cartesia', () => {
    it.skip('requires CARTESIA_API_KEY and OPENAI_API_KEY', () => {});
  });
}

// A single 24 kHz mono s16le frame's worth of silence, base64-encoded the way
// Cartesia sends audio chunks.
const CHUNK_BASE64 = Buffer.alloc(4800).toString('base64');

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for promise')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// A minimal Cartesia TTS WebSocket server: for every generation it replies with
// one audio chunk and a done message, echoing the caller's context_id. `onStop`
// lets a test override the reply (e.g. to simulate a provider failure); return
// false to suppress the normal chunk/done reply.
function serveCartesia(
  wss: WebSocketServer,
  onStop?: (ws: WebSocket, contextId: string, connectionNumber: number) => boolean,
): { connectionCount: () => number } {
  let connectionCount = 0;
  wss.on('connection', (ws) => {
    connectionCount++;
    const connectionNumber = connectionCount;
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { context_id: string; continue?: boolean };
      if (message.continue !== false) return; // only reply once the turn is closed
      const contextId = message.context_id;
      if (onStop && !onStop(ws, contextId, connectionNumber)) return;
      ws.send(
        JSON.stringify({
          type: 'chunk',
          data: CHUNK_BASE64,
          done: false,
          status_code: 200,
          step_time: 0,
          context_id: contextId,
        }),
      );
      ws.send(
        JSON.stringify({ type: 'done', done: true, status_code: 200, context_id: contextId }),
      );
    });
  });
  return { connectionCount: () => connectionCount };
}

async function synthesizeTurn(
  cartesia: TTS,
  text: string,
  connOptions?: APIConnectOptions,
): Promise<tts.SynthesizedAudio[]> {
  const stream = cartesia.stream({ connOptions });
  stream.pushText(text);
  stream.endInput();

  try {
    const events: tts.SynthesizedAudio[] = [];
    for await (const event of stream) {
      if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
    }
    return events;
  } finally {
    stream.close();
  }
}

describe('Cartesia streaming pool', () => {
  it('reuses one websocket across sequential turns', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveCartesia(wss);

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      expect(await synthesizeTurn(cartesia, 'first turn.')).not.toHaveLength(0);
      expect(await synthesizeTurn(cartesia, 'second turn.')).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(1);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('prewarms and reuses the ready websocket', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveCartesia(wss);
    const connected = once(wss, 'connection');

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      cartesia.prewarm();
      await waitFor(connected);
      expect(await synthesizeTurn(cartesia, 'prewarmed turn.')).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(1);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('discards a poisoned websocket after a failure', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    // The first connection drops the turn; the second serves it normally.
    const server = serveCartesia(wss, (ws, _contextId, connectionNumber) => {
      if (connectionNumber === 1) {
        ws.close(1011, 'provider failure');
        return false;
      }
      return true;
    });

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      expect(
        await synthesizeTurn(cartesia, 'failing turn.', {
          ...DEFAULT_API_CONNECT_OPTIONS,
          maxRetry: 0,
        }),
      ).toHaveLength(0);
      expect(await synthesizeTurn(cartesia, 'recovery turn.')).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(2);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('replaces a websocket that closed while idle', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let firstConnectionClosed: (() => void) | undefined;
    const firstClosed = new Promise<void>((resolve) => {
      firstConnectionClosed = resolve;
    });
    const server = serveCartesia(wss, (ws, _contextId, connectionNumber) => {
      if (connectionNumber === 1) {
        ws.on('close', () => firstConnectionClosed?.());
        // Serve the turn, then drop the idle socket so the next turn reconnects.
        setTimeout(() => ws.close(), 10);
      }
      return true;
    });

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      expect(await synthesizeTurn(cartesia, 'first turn.')).not.toHaveLength(0);
      await waitFor(firstClosed);
      // Let the client observe the close so the idle handler removes the socket
      // before the next checkout, making the maxRetry: 0 assertion deterministic.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // maxRetry: 0 proves the idle-closed socket was dropped from the pool, not
      // handed back to burn the turn's only attempt.
      expect(
        await waitFor(
          synthesizeTurn(cartesia, 'second turn.', { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 }),
        ),
      ).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(2);
    } finally {
      await cartesia.close();
      await closeWebSocketServer(wss);
    }
  });

  it('closes the pooled websocket when the TTS closes', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    serveCartesia(wss);

    const cartesia = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      await synthesizeTurn(cartesia, 'closing turn.');
      await cartesia.close();
      // close() drains the pooled socket; give the close frame a beat to land.
      await waitFor(
        (async () => {
          while (wss.clients.size > 0) await new Promise((r) => setTimeout(r, 5));
        })(),
      );
      expect(wss.clients.size).toBe(0);
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});
