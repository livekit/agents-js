// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt as sttLib } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

function makeFrame(samplesPerChannel = 800, sampleRate = 16000): AudioFrame {
  const data = new Int16Array(samplesPerChannel);
  data.fill(1);
  return new AudioFrame(data, sampleRate, 1, samplesPerChannel);
}

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseUrl: `ws://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
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

async function collectUntilEnd(stream: sttLib.SpeechStream): Promise<sttLib.SpeechEvent[]> {
  const events: sttLib.SpeechEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === sttLib.SpeechEventType.END_OF_SPEECH) break;
  }
  return events;
}

describe('AssemblyAI STT metadata', () => {
  it('maps turn confidence fields onto speech data metadata', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (ws, req) => {
      requestUrl = req.url ?? '';
      ws.on('message', () => {
        ws.send(
          JSON.stringify({
            type: 'Turn',
            transcript: 'hola mundo',
            utterance: 'hola mundo',
            end_of_turn: true,
            language_code: 'es',
            language_confidence: 0.94,
            words: [
              { text: 'hola', start: 0, end: 200, confidence: 0.96 },
              { text: 'mundo', start: 200, end: 500, confidence: 0.98 },
            ],
          }),
        );
      });
    });

    try {
      const assemblyai = new STT({
        apiKey: 'test-key',
        baseUrl,
        speechModel: 'u3-rt-pro',
      });
      const stream = assemblyai.stream({
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });

      await waitUntil(() => requestUrl !== '');

      stream.pushFrame(makeFrame());
      stream.endInput();

      const events = await collectUntilEnd(stream);
      stream.close();

      expect(new URL(`ws://127.0.0.1${requestUrl}`).pathname).toBe('/v3/ws');
      expect(
        events
          .filter((event) => event.alternatives?.[0])
          .map((event) => ({
            type: event.type,
            language: event.alternatives?.[0]?.language,
            metadata: event.alternatives?.[0]?.metadata,
          })),
      ).toEqual([
        {
          type: sttLib.SpeechEventType.INTERIM_TRANSCRIPT,
          language: 'es',
          metadata: {
            assemblyai: {
              languageConfidence: 0.94,
            },
          },
        },
        {
          type: sttLib.SpeechEventType.PREFLIGHT_TRANSCRIPT,
          language: 'es',
          metadata: {
            assemblyai: {
              languageConfidence: 0.94,
            },
          },
        },
        {
          type: sttLib.SpeechEventType.FINAL_TRANSCRIPT,
          language: 'es',
          metadata: {
            assemblyai: {
              languageConfidence: 0.94,
            },
          },
        },
      ]);
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});
