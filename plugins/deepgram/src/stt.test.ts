// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt as agentStt } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { SpeechStream } from './stt.js';
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

describe('Deepgram energy gating', () => {
  // 100ms at 16kHz, exactly one JS repack chunk. makeFrame is far below the energy
  // filter's RMS threshold, so these only pass the gate while the cooldown lasts.
  const FRAME_SAMPLES = 1600;
  // Longer than the filter's one second cooldown, so the gate closes partway through.
  const QUIET_FRAMES = 15;

  const countAudio = (wire: string[]) => wire.filter((entry) => entry === 'audio').length;

  function collectEvents(stream: SpeechStream): agentStt.SpeechEventType[] {
    const types: agentStt.SpeechEventType[] = [];
    void (async () => {
      try {
        for await (const event of stream) types.push(event.type);
      } catch {
        // the stream throws on close, which every test does in its finally block
      }
    })();
    return types;
  }

  it('stops sending low-energy audio once the cooldown elapses', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const wire: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        wire.push(isBinary ? 'audio' : (JSON.parse(data.toString()) as { type: string }).type);
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    try {
      for (let i = 0; i < QUIET_FRAMES; i++) stream.pushFrame(makeFrame(FRAME_SAMPLES));
      // Finalize is ordered behind every frame already sent, so it is a barrier.
      stream.flush();
      await waitUntil(() => wire.includes('Finalize'));

      expect(countAudio(wire)).toBeLessThan(QUIET_FRAMES);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('keeps sending low-energy audio while an utterance is in progress', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const wire: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        wire.push(isBinary ? 'audio' : (JSON.parse(data.toString()) as { type: string }).type);
        // Announced on the first frame rather than on connection: the plugin only
        // attaches its message listener once the socket is open, so anything sent
        // before it has sent audio is dropped.
        if (countAudio(wire) === 1) ws.send(JSON.stringify({ type: 'SpeechStarted' }));
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    const events = collectEvents(stream);
    try {
      stream.pushFrame(makeFrame(FRAME_SAMPLES));
      await waitUntil(() => events.includes(agentStt.SpeechEventType.START_OF_SPEECH));

      for (let i = 0; i < QUIET_FRAMES; i++) stream.pushFrame(makeFrame(FRAME_SAMPLES));
      stream.flush();
      await waitUntil(() => wire.includes('Finalize'));

      expect(countAudio(wire)).toBe(QUIET_FRAMES + 1);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('does not carry an unfinished utterance into a reconnected websocket', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const wires: string[][] = [];
    wss.on('connection', (ws) => {
      const wire: string[] = [];
      wires.push(wire);
      // Only the first connection reports speech; the reconnect never hears about it.
      const announcesSpeech = wires.length === 1;
      ws.on('message', (data, isBinary) => {
        wire.push(isBinary ? 'audio' : (JSON.parse(data.toString()) as { type: string }).type);
        if (announcesSpeech && countAudio(wire) === 1) {
          ws.send(JSON.stringify({ type: 'SpeechStarted' }));
        }
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    const events = collectEvents(stream);
    try {
      stream.pushFrame(makeFrame(FRAME_SAMPLES));
      await waitUntil(() => events.includes(agentStt.SpeechEventType.START_OF_SPEECH));

      // Reconnects mid-utterance, without Deepgram ever endpointing it.
      stream.updateOptions({ keyterm: ['livekit'] });
      await waitUntil(() => wires.length === 2);

      // Finalize on the new socket proves its send loop is running.
      stream.pushFrame(makeFrame(FRAME_SAMPLES));
      stream.flush();
      await waitUntil(() => wires[1]!.includes('Finalize'));

      expect(stream._speaking).toBe(false);
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
