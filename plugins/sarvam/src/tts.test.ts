// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts as agentTts } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const hasSarvamApiKey = Boolean(process.env.SARVAM_API_KEY);

describe('Sarvam TTS', () => {
  it.skipIf(!hasSarvamApiKey)('runs integration suite with real API key', async () => {
    await tts(new TTS({ apiKey: process.env.SARVAM_API_KEY }), new STT(), { streaming: false });
  });

  it('supports opting into non-streaming mode', () => {
    const nonStreamingTts = new TTS({ apiKey: 'dummy-api-key', streaming: false });

    expect(nonStreamingTts.capabilities.streaming).toBe(false);
    expect(() => nonStreamingTts.stream()).toThrow(/streaming is disabled/i);
  });

  it('delivers retry audio before the stream end after a provider error', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const receivedText: string[][] = [];
    const closedAttempts: number[] = [];
    server.on('connection', (socket) => {
      const text: string[] = [];
      const attempt = receivedText.push(text);
      socket.on('close', () => closedAttempts.push(attempt));
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: { text: string } };
        if (message.type === 'text') text.push(message.data!.text);
        if (message.type !== 'flush') return;
        if (attempt === 1) {
          socket.send(JSON.stringify({ type: 'error', data: { code: 500, message: 'try again' } }));
          return;
        }
        socket.send(
          JSON.stringify({ type: 'audio', data: { audio: Buffer.alloc(4800).toString('base64') } }),
        );
        socket.send(JSON.stringify({ type: 'event', data: { event_type: 'final' } }));
      });
    });

    const { port } = server.address() as AddressInfo;
    const provider = new TTS({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}` });
    const errors: unknown[] = [];
    provider.on('error', (error) => errors.push(error));
    const stream = provider.stream();
    const events: agentTts.SynthesizedAudio[] = [];
    try {
      stream.pushText('Read this sentence.');
      stream.endInput();
      for await (const event of stream) {
        if (event === agentTts.SynthesizeStream.END_OF_STREAM) break;
        events.push(event);
      }

      expect(closedAttempts).toContain(1);
      expect(receivedText).toEqual([['Read this sentence.'], ['Read this sentence.']]);
      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.final).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
