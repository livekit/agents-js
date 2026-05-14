// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

async function captureStreamInit(opts: { chunkLengthSchedule?: number[]; autoMode?: boolean }) {
  const { wss, baseURL } = await startWebSocketServer();
  const messages: Record<string, unknown>[] = [];
  let requestUrl = '';

  wss.on('connection', (ws, req) => {
    requestUrl = req.url ?? '';
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);

      if (messages.length >= 2) {
        ws.send(JSON.stringify({ contextId: messages[0]?.context_id, isFinal: true }));
      }
    });
  });

  const elevenlabs = new TTS({
    apiKey: 'test-key',
    baseURL,
    chunkLengthSchedule: opts.chunkLengthSchedule,
    autoMode: opts.autoMode,
  });
  const stream = elevenlabs.stream();

  try {
    stream.pushText('hello world.');
    stream.endInput();
    await waitUntil(() => messages.length >= 2);

    return {
      initPacket: messages[0]!,
      requestUrl,
    };
  } finally {
    stream.close();
    await elevenlabs.close();
    await closeWebSocketServer(wss);
  }
}

const hasElevenlabsConfig = Boolean(process.env.ELEVEN_API_KEY && process.env.OPENAI_API_KEY);

if (hasElevenlabsConfig) {
  describe('ElevenLabs', () => {
    it('runs the shared TTS integration tests', async () => {
      const openaiPackage = '@livekit/agents-plugin-openai';
      const testPackage = '@livekit/agents-plugins-test';
      const [{ STT }, { tts }] = await Promise.all([
        import(/* @vite-ignore */ openaiPackage),
        import(/* @vite-ignore */ testPackage),
      ]);

      await tts(new TTS(), new STT());
    });
  });
} else {
  describe('ElevenLabs', () => {
    it.skip('requires ELEVEN_API_KEY and OPENAI_API_KEY', () => {});
  });
}

describe('ElevenLabs TTS options', () => {
  it('includes chunk length schedule in the WebSocket init packet', async () => {
    const { initPacket, requestUrl } = await captureStreamInit({
      chunkLengthSchedule: [80, 120],
    });

    expect(initPacket.generation_config).toEqual({ chunk_length_schedule: [80, 120] });
    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('false');
  });

  it('omits generation config when chunk length schedule is unset', async () => {
    const { initPacket, requestUrl } = await captureStreamInit({});

    expect(initPacket).not.toHaveProperty('generation_config');
    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('true');
  });

  it('respects explicit autoMode with chunk length schedule', async () => {
    const { requestUrl } = await captureStreamInit({
      chunkLengthSchedule: [80, 120],
      autoMode: true,
    });

    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('true');
  });
});
