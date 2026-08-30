// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, initializeLogger, tts } from '@livekit/agents';
import { once } from 'node:events';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { connectWebSocket } from './_utils.js';
import type { GrokVoices } from './tts.js';
import { TTS } from './tts.js';

const CANONICAL_GROK_VOICES = [
  'carina',
  'zagan',
  'helix',
  'orion',
  'luna',
  'iris',
  'altair',
  'zenith',
  'perseus',
  'helios',
  'lux',
  'kepler',
  'rigel',
  'cosmo',
  'celeste',
  'ursa',
  'sirius',
  'lumen',
  'castor',
  'naksh',
  'atlas',
  'ara',
  'eve',
  'leo',
  'rex',
  'sal',
] as const satisfies readonly GrokVoices[];

const LEGACY_GROK_VOICES = [
  'Ara',
  'Eve',
  'Leo',
  'Rex',
  'Sal',
] as const satisfies readonly GrokVoices[];

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');

  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected websocket server to listen on a TCP port');
  }

  return { wss, url: `ws://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

describe('xAI TTS', () => {
  it('supports canonical and legacy Grok voice names', () => {
    expect(CANONICAL_GROK_VOICES).toHaveLength(26);
    expect(LEGACY_GROK_VOICES).toEqual(['Ara', 'Eve', 'Leo', 'Rex', 'Sal']);
  });

  it('reports its streaming capabilities and provider metadata', async () => {
    const xai = new TTS({ apiKey: 'test-key' });
    try {
      expect(xai.capabilities.streaming).toBe(true);
      expect(xai.sampleRate).toBe(24_000);
      expect(xai.numChannels).toBe(1);
      expect(xai.provider).toBe('xAI');
      expect(xai.model).toBe('unknown');
    } finally {
      await xai.close();
    }
  });

  it('redacts API keys from rejected WebSocket handshakes', async () => {
    const secret = 'secret-api-key-do-not-log';
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, done) => done(false, 401, 'Unauthorized'),
    });
    await once(wss, 'listening');
    const address = wss.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected websocket server to listen on a TCP port');
    }
    try {
      const error = await connectWebSocket({
        url: `ws://127.0.0.1:${address.port}`,
        headers: { Authorization: `Bearer ${secret}` },
        timeoutMs: 5_000,
      }).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
      expect((error as Error).message).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});

describe('xAI TTS websocket pool', () => {
  it('reuses fresh connections and rotates them after 1800 seconds', async () => {
    const { wss, url } = await startWebSocketServer();
    const audio = Buffer.alloc(4_800).toString('base64');
    let connectionCount = 0;

    wss.on('connection', (ws) => {
      connectionCount++;
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'text.done') {
          ws.send(JSON.stringify({ type: 'audio.delta', delta: audio }));
          ws.send(JSON.stringify({ type: 'audio.done' }));
        }
      });
    });

    const xai = new TTS({ apiKey: 'test-key' });
    vi.spyOn(xai, 'connectWs').mockImplementation(async () => {
      const ws = new WebSocket(url);
      await once(ws, 'open');
      return ws;
    });

    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const first = await xai.synthesize('first utterance').collect();
      now += 1_000;
      const second = await xai.synthesize('second utterance').collect();

      expect(first.samplesPerChannel).toBeGreaterThan(0);
      expect(second.samplesPerChannel).toBeGreaterThan(0);
      expect(connectionCount).toBe(1);

      now += 1_800_001;
      const third = await xai.synthesize('third utterance').collect();

      expect(third.samplesPerChannel).toBeGreaterThan(0);
      expect(connectionCount).toBe(2);
    } finally {
      await xai.close();
      await closeWebSocketServer(wss);
    }
  });

  it('synthesizes multiple flushed segments over one connection', async () => {
    const { wss, url } = await startWebSocketServer();
    const audio = Buffer.alloc(4_800).toString('base64');
    let connectionCount = 0;

    wss.on('connection', (ws) => {
      connectionCount++;
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'text.done') {
          ws.send(JSON.stringify({ type: 'audio.delta', delta: audio }));
          ws.send(JSON.stringify({ type: 'audio.done' }));
        }
      });
    });

    const xai = new TTS({ apiKey: 'test-key' });
    vi.spyOn(xai, 'connectWs').mockImplementation(async () => {
      const ws = new WebSocket(url);
      await once(ws, 'open');
      return ws;
    });

    const stream = xai.stream();
    try {
      stream.pushText('first segment');
      stream.flush();
      stream.pushText('second segment');
      stream.endInput();

      let finalFrames = 0;
      for await (const event of stream) {
        if (event === tts.SynthesizeStream.END_OF_STREAM) continue;
        if (event.final) finalFrames++;
      }

      expect(finalFrames).toBe(2);
      expect(connectionCount).toBe(1);
    } finally {
      stream.close();
      await xai.close();
      await closeWebSocketServer(wss);
    }
  });
});
