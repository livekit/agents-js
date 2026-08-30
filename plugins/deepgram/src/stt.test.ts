// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, DEFAULT_API_CONNECT_OPTIONS, stt as sttLib } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

function makeFrame(samplesPerChannel: number, sampleRate = 16000): AudioFrame {
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
  for (const client of wss.clients) client.close();
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

describe('Deepgram WebSocket handshake', () => {
  it('redacts API keys from rejected handshakes', async () => {
    const secret = 'secret-api-key-do-not-log';
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, done) => done(false, 401, 'Unauthorized'),
    });
    await once(wss, 'listening');
    const address = wss.address() as AddressInfo;
    const deepgram = new STT({
      apiKey: secret,
      baseUrl: `ws://127.0.0.1:${address.port}`,
    });
    const errorEvent = once(deepgram, 'error');
    const stream = deepgram.stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
    });

    try {
      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
      expect(error.message).not.toContain(secret);
      expect(error.toString()).not.toContain(secret);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });
});

describe('Deepgram streaming flush', () => {
  it('finalizes the turn when no audio is left to send', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const wire: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        wire.push(isBinary ? 'audio' : (JSON.parse(data.toString()) as { type: string }).type);
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    try {
      // 100ms is exactly one JS repack chunk, so flush() returns no frames.
      stream.pushFrame(makeFrame(1600));
      await waitUntil(() => wire.join(',') === 'audio');

      stream.flush();
      await waitUntil(() => wire.join(',') === 'audio,Finalize');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('finalizes after the buffered audio', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const wire: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        wire.push(isBinary ? 'audio' : (JSON.parse(data.toString()) as { type: string }).type);
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    try {
      stream.pushFrame(makeFrame(480));
      stream.flush();
      await waitUntil(() => wire.join(',') === 'audio,Finalize');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });
});

describe('Deepgram speech end time', () => {
  it('maps a speech-final result boundary', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    wss.on('connection', (ws) => {
      ws.once('message', () => {
        ws.send(JSON.stringify({ type: 'SpeechStarted' }));
        ws.send(
          JSON.stringify({
            type: 'Results',
            metadata: { request_id: 'request' },
            is_final: true,
            speech_final: true,
            start: 0,
            duration: 0.1,
            channel: {
              alternatives: [
                {
                  transcript: 'hello',
                  confidence: 1,
                  words: [{ word: 'hello', start: 0, end: 0.08, confidence: 1 }],
                },
              ],
            },
          }),
        );
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    try {
      stream.pushFrame(makeFrame(1600));
      const events = await collectUntilEnd(stream);
      expect(events.at(-1)?.speechEndTime).toBe(stream.startTime + 80);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('maps an utterance-end last-word boundary', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    wss.on('connection', (ws) => {
      ws.once('message', () => {
        ws.send(JSON.stringify({ type: 'SpeechStarted' }));
        ws.send(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 0.08 }));
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    try {
      stream.pushFrame(makeFrame(1600));
      const events = await collectUntilEnd(stream);
      expect(events.at(-1)?.speechEndTime).toBe(stream.startTime + 80);
    } finally {
      stream.close();
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
