// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type RawData, WebSocketServer } from 'ws';
import { STT } from './stt.js';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100 ms
const FRAME_BYTES = FRAME_SAMPLES * 2;

function makeFrame(): AudioFrame {
  const data = new Int16Array(FRAME_SAMPLES);
  data.fill(1);
  return new AudioFrame(data, SAMPLE_RATE, 1, FRAME_SAMPLES);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

describe('AssemblyAI audio after a reconnect', () => {
  it('delivers every frame to the new connection', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(wss, 'listening');
    const baseUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;

    let connections = 0;
    let secondConnectionBytes = 0;
    wss.on('connection', (ws) => {
      connections += 1;
      if (connections === 1) {
        // the first socket drops, which makes the stream reconnect
        setTimeout(() => ws.close(), 50);
        return;
      }
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) secondConnectionBytes += (data as Buffer).byteLength;
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl, sampleRate: SAMPLE_RATE }).stream();
    try {
      await waitUntil(() => connections >= 2);

      const frames = 6;
      for (let i = 0; i < frames; i++) stream.pushFrame(makeFrame());

      // The connection that ended must not keep a read open on the shared audio queue and
      // take frames that belong to this one.
      await waitUntil(() => secondConnectionBytes >= frames * FRAME_BYTES, 3000);
      expect(secondConnectionBytes).toBe(frames * FRAME_BYTES);
    } finally {
      stream.close();
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 20000);
});
