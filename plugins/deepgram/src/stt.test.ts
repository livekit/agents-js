// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `ws://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.terminate();
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

function makeFrame(ms: number, sampleRate = 16000): AudioFrame {
  const samples = Math.floor((sampleRate * ms) / 1000);
  const data = new Int16Array(samples);
  data.fill(10_000);
  return new AudioFrame(data, sampleRate, 1, samples);
}

function sent(wire: string[]): string[] {
  return wire.filter((msg) => msg !== 'KeepAlive');
}

describe('Deepgram streaming language detection', () => {
  // Deepgram only supports language detection for prerecorded audio, so a
  // streaming session must reject it rather than silently default to English.
  // Mirrors livekit-plugins-deepgram (Python).
  it('throws when starting a stream with detectLanguage enabled', () => {
    const stt = new STT({ apiKey: 'test', detectLanguage: true });
    expect(() => stt.stream()).toThrow('language detection is not supported in streaming mode');
  });

  it('allows streaming with an explicit language', () => {
    const stt = new STT({ apiKey: 'test', language: 'en-US' });
    const stream = stt.stream();
    // Close immediately so the connection loop never starts (no network in unit tests).
    stream.close();
  });
});

describe('Deepgram STT flush finalization', () => {
  it('finalizes the turn when no audio is left to send', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const wire: string[] = [];
    let stream: ReturnType<STT['stream']> | undefined;

    wss.on('connection', (ws) => {
      ws.on('message', (raw, isBinary) => {
        wire.push(isBinary ? 'audio' : (JSON.parse(raw.toString()) as { type: string }).type);
      });
    });

    try {
      const deepgram = new STT({ apiKey: 'test-key', baseUrl: baseURL, sampleRate: 16000 });
      stream = deepgram.stream();

      stream.flush();
      await waitUntil(() => sent(wire).includes('Finalize'));
      expect(sent(wire).indexOf('Finalize')).toBeLessThan(sent(wire).indexOf('CloseStream'));
    } finally {
      stream?.close();
      await closeWebSocketServer(wss);
    }
  });

  it('finalizes after the buffered audio', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const wire: string[] = [];
    let stream: ReturnType<STT['stream']> | undefined;

    wss.on('connection', (ws) => {
      ws.on('message', (raw, isBinary) => {
        wire.push(isBinary ? 'audio' : (JSON.parse(raw.toString()) as { type: string }).type);
      });
    });

    try {
      const deepgram = new STT({ apiKey: 'test-key', baseUrl: baseURL, sampleRate: 16000 });
      stream = deepgram.stream();

      stream.pushFrame(makeFrame(30));
      stream.flush();
      await waitUntil(() => sent(wire).join(',') === 'audio,Finalize');
    } finally {
      stream?.close();
      await closeWebSocketServer(wss);
    }
  });
});

if (hasDeepgramApiKey) {
  describe('Deepgram', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
