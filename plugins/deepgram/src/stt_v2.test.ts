// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { stt } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt as runStt } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STTv2, type STTv2Options } from './stt_v2.js';

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

if (hasDeepgramApiKey) {
  describe('Deepgram STTv2 (Flux)', async () => {
    await runStt(new STTv2(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram STTv2 (Flux)', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}

async function startWebSocketServer(): Promise<{ wss: WebSocketServer; endpointUrl: string }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, endpointUrl: `ws://127.0.0.1:${address.port}/v2/listen` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

function updateStreamOptions(stream: stt.SpeechStream, opts: Partial<STTv2Options>) {
  (stream as unknown as { updateOptions(opts: Partial<STTv2Options>): void }).updateOptions(opts);
}

async function waitForNoMessage(ws: WebSocket) {
  const message = await Promise.race([
    once(ws, 'message').then(([data]) => data),
    new Promise<undefined>((resolve) => setTimeout(resolve, 50)),
  ]);
  expect(message).toBeUndefined();
}

describe('Deepgram STTv2 Flux Configure updates', () => {
  it('reconfigures live fields without reconnecting', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connection = once(wss, 'connection') as Promise<[WebSocket]>;

    try {
      const deepgram = new STTv2({ apiKey: 'test-key', endpointUrl, eotThreshold: 0.7 });
      const stream = deepgram.stream({
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });
      const [ws] = await connection;

      const message = once(ws, 'message');
      updateStreamOptions(stream, {
        eotThreshold: 0.85,
        keyterms: ['LiveKit'],
        languageHint: ['en'],
      });

      const [data] = (await message) as [Buffer];
      expect(JSON.parse(data.toString())).toEqual({
        type: 'Configure',
        thresholds: { eot_threshold: 0.85 },
        keyterms: ['LiveKit'],
        language_hints: ['en'],
      });
      expect(wss.clients.size).toBe(1);

      stream.close();
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('reconnect fields skip in-band Configure', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const firstConnection = once(wss, 'connection') as Promise<[WebSocket]>;

    try {
      const deepgram = new STTv2({ apiKey: 'test-key', endpointUrl });
      const stream = deepgram.stream({
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });
      const [firstWs] = await firstConnection;
      const secondConnection = once(wss, 'connection') as Promise<[WebSocket]>;

      updateStreamOptions(stream, { model: 'flux-general-multi', eotThreshold: 0.8 });

      await secondConnection;
      await waitForNoMessage(firstWs);

      stream.close();
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('sends only changed fields in Configure', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connection = once(wss, 'connection') as Promise<[WebSocket]>;

    try {
      const deepgram = new STTv2({
        apiKey: 'test-key',
        endpointUrl,
        eotThreshold: 0.7,
        keyterms: ['existing'],
      });
      const stream = deepgram.stream({
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });
      const [ws] = await connection;

      const message = once(ws, 'message');
      updateStreamOptions(stream, { keyterms: ['LiveKit', 'Deepgram'] });

      const [data] = (await message) as [Buffer];
      expect(JSON.parse(data.toString())).toEqual({
        type: 'Configure',
        keyterms: ['LiveKit', 'Deepgram'],
      });

      stream.close();
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('orders rapid Configure sends', async () => {
    const { wss, endpointUrl } = await startWebSocketServer();
    const connection = once(wss, 'connection') as Promise<[WebSocket]>;

    try {
      const deepgram = new STTv2({ apiKey: 'test-key', endpointUrl, eotThreshold: 0.7 });
      const stream = deepgram.stream({
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });
      const [ws] = await connection;

      const messages: Array<{ thresholds: { eot_threshold: number } }> = [];
      ws.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
      updateStreamOptions(stream, { eotThreshold: 0.8 });
      updateStreamOptions(stream, { eotThreshold: 0.9 });

      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (messages.length === 2) {
            clearInterval(interval);
            resolve();
          }
        }, 5);
      });

      expect(messages.map((message) => message.thresholds.eot_threshold)).toEqual([0.8, 0.9]);

      stream.close();
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});
