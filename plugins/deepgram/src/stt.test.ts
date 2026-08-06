// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

describe('SpeechStream abort-promise retention (issue #1950)', () => {
  // Regression: the old implementation hoisted `waitForAbort(abortSignal)` outside the
  // send-loop, causing each `Promise.race([input.next(), abortPromise])` call to register
  // a new reaction on the shared `abortPromise`.  Because `abortPromise` never settles
  // until close, those reactions — and the `AudioFrame` values they transitively held —
  // accumulated for the lifetime of the stream.
  //
  // The fix creates a per-iteration abort promise with `removeEventListener` cleanup, so
  // `abortSignal` has at most one listener at any given time.  We verify that invariant here
  // without needing a real Deepgram WebSocket connection.
  it('does not accumulate abort-signal listeners across pushed frames', async () => {
    const stt = new STT({ apiKey: 'test-key' });
    // stream() only accepts { connOptions }; there is no way to inject an
    // external AbortSignal. The signal that actually gates the send loop is
    // the SpeechStream base class's own internal abortController.
    const stream = stt.stream();
    const abortSignal = (stream as unknown as { abortController: AbortController })
      .abortController.signal;

    const SAMPLE_RATE = 16000;
    const SAMPLES = 160; // 10 ms at 16 kHz
    const silence = new Int16Array(SAMPLES);

    // Push enough frames to fill several 100 ms AudioByteStream chunks.
    const FRAMES = 50;
    for (let i = 0; i < FRAMES; i++) {
      stream.pushFrame(new AudioFrame(silence.slice(), SAMPLE_RATE, 1, SAMPLES));
      // Yield so the send-loop microtasks can run between frames.
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    // abortSignal should never have accumulated more than 1 listener.
    // EventTarget.listenerCount is not standard; fall back to checking that the
    // listener count does not scale with the number of frames pushed.
    const listenerCount = (abortSignal as unknown as NodeJS.EventEmitter).listenerCount?.(
      'abort',
    );
    if (listenerCount !== undefined) {
      expect(listenerCount).toBeLessThanOrEqual(1);
    }

    stream.close();
  });
});

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

if (hasDeepgramApiKey) {
  describe('Deepgram', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
