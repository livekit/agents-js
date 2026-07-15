// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { decode, encode } from '@msgpack/msgpack';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

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

async function startSynthesis(wss: WebSocketServer) {
  const stopReceived = new Promise<WebSocket>((resolve) => {
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
        if (message.event === 'stop') resolve(ws);
      });
    });
  });

  const fishAudio = new TTS({
    apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
  });
  const stream = fishAudio.stream();
  stream.pushText('hello world.');
  stream.endInput();

  return { fishAudio, stream, ws: await waitFor(stopReceived) };
}

const hasFishAudioConfig = Boolean(process.env.FISH_API_KEY && process.env.OPENAI_API_KEY);

if (hasFishAudioConfig) {
  describe('FishAudio', async () => {
    await testTts(new TTS(), new STT({ useRealtime: false }));
  });
} else {
  describe('FishAudio', () => {
    it.skip('requires FISH_API_KEY and OPENAI_API_KEY', () => {});
  });
}

describe('FishAudio streaming', () => {
  it('emits the first complete frame before the next provider event', async () => {
    const { wss } = await startWebSocketServer();
    const { fishAudio, stream, ws } = await startSynthesis(wss);

    try {
      ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));

      const first = await waitFor(stream.next());
      expect(first.done).toBe(false);
      expect(first.value).not.toBe(tts.SynthesizeStream.END_OF_STREAM);
      if (first.value !== tts.SynthesizeStream.END_OF_STREAM) {
        expect(first.value.frame.samplesPerChannel).toBe(2400);
        expect(first.value.final).toBe(false);
      }

      ws.send(encode({ event: 'finish', reason: 'stop' }));
      for await (const _event of stream) {
        // Drain the stream so its tasks finish before cleanup.
      }
    } finally {
      stream.close();
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('marks the terminal frame final before ending the stream', async () => {
    const { wss } = await startWebSocketServer();
    const { fishAudio, stream, ws } = await startSynthesis(wss);

    try {
      ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));
      ws.send(encode({ event: 'finish', reason: 'stop' }));

      const events: tts.SynthesizedAudio[] = [];
      for await (const event of stream) {
        if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.final).toBe(true);
    } finally {
      stream.close();
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });
});
