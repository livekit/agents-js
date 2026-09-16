// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIError,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
} from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTSv2 } from './tts_v2.js';

const SAMPLE_RATE = 24000;
// One 10ms frame of silence, the shape Flux streams back between SpeechStarted and
// SpeechMetadata.
const PCM_CHUNK = Buffer.alloc((SAMPLE_RATE / 100) * 2);

interface FakeFluxServer {
  baseUrl: string;
  /** Text of every `Speak` message the server received, in order. */
  spoken: string[];
  /** Number of accepted WebSocket connections — 1 means the pool reused its socket. */
  connections: number;
  close(): Promise<void>;
}

/**
 * A local server that speaks the Flux `/v2/speak` protocol: `Connected` on open, then
 * `SpeechStarted` → audio → `SpeechMetadata` → `Flushed` for each turn the client flushes.
 */
async function startFakeFluxServer(options: { failWith?: string } = {}): Promise<FakeFluxServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');

  const server: FakeFluxServer = {
    baseUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    spoken: [],
    connections: 0,
    close: async () => {
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (ws: WebSocket) => {
    server.connections += 1;
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'Connected', request_id: 'req-1' }));

    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; text?: string };
      if (message.type === 'Speak') {
        server.spoken.push(message.text ?? '');
        return;
      }
      if (message.type !== 'Flush') return;

      if (options.failWith) {
        ws.send(JSON.stringify({ type: 'Error', description: options.failWith }));
        return;
      }

      ws.send(JSON.stringify({ type: 'SpeechStarted' }));
      ws.send(PCM_CHUNK, { binary: true });
      ws.send(JSON.stringify({ type: 'SpeechMetadata', request_id: 'req-1' }));
      // Flux emits a trailing Flushed after SpeechMetadata; the client must absorb it.
      ws.send(JSON.stringify({ type: 'Flushed' }));
    });
  });

  return server;
}

async function synthesizeTurn(
  ttsv2: TTSv2,
  text: string,
  connOptions?: APIConnectOptions,
): Promise<{ audio: tts.SynthesizedAudio[]; endOfStreamCount: number }> {
  const stream = ttsv2.stream({ connOptions });
  stream.pushText(text);
  stream.endInput();

  const audio: tts.SynthesizedAudio[] = [];
  let endOfStreamCount = 0;
  try {
    for await (const event of stream) {
      if (event === tts.SynthesizeStream.END_OF_STREAM) {
        endOfStreamCount += 1;
        // The segment is complete; nothing follows for a single-segment turn.
        break;
      }
      audio.push(event);
    }
  } finally {
    stream.close();
  }

  return { audio, endOfStreamCount };
}

describe('Deepgram TTSv2 (Flux) streaming', () => {
  let cleanup: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  const setup = async (serverOptions: { failWith?: string } = {}) => {
    const server = await startFakeFluxServer(serverOptions);
    const ttsv2 = new TTSv2({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      sampleRate: SAMPLE_RATE,
    });
    cleanup.push(() => server.close());
    cleanup.push(() => ttsv2.close());
    return { server, ttsv2 };
  };

  it('sends each word as a Speak message and ends the turn with a Flush', async () => {
    const { server, ttsv2 } = await setup();

    const { audio, endOfStreamCount } = await synthesizeTurn(ttsv2, 'hello world');

    expect(server.spoken).toEqual(['hello ', 'world ']);
    expect(audio.length).toBeGreaterThan(0);
    expect(audio.at(-1)!.final).toBe(true);
    expect(endOfStreamCount).toBe(1);
  });

  // SpeechMetadata, not the trailing Flushed, is the authoritative end-of-turn marker.
  it('reuses the pooled socket across turns', async () => {
    const { server, ttsv2 } = await setup();

    await synthesizeTurn(ttsv2, 'first turn');
    await synthesizeTurn(ttsv2, 'second turn');

    expect(server.connections).toBe(1);
    expect(server.spoken).toEqual(['first ', 'turn ', 'second ', 'turn ']);
  });

  // The base SynthesizeStream swallows the thrown error to avoid an unhandled rejection
  // and reports it on the TTS `error` event instead, so that is what a caller observes.
  it('surfaces a server Error message as an APIError on the error event', async () => {
    const { ttsv2 } = await setup({ failWith: 'model unavailable' });

    const errors: { error: Error; recoverable: boolean }[] = [];
    ttsv2.on('error', (ev) => errors.push({ error: ev.error, recoverable: ev.recoverable }));

    const { audio } = await synthesizeTurn(ttsv2, 'hello', {
      ...DEFAULT_API_CONNECT_OPTIONS,
      maxRetry: 0,
    });

    expect(audio).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(APIError);
    expect(errors[0]!.recoverable).toBe(false);
  });
});

describe('Deepgram TTSv2 encoding validation', () => {
  // AudioByteStream expects raw PCM and this plugin has no decoder, so a compressed
  // encoding must fail loudly rather than emit garbage frames.
  it.each(['mp3', 'opus', 'flac', 'aac', 'mulaw'])('rejects %s', (encoding) => {
    expect(() => new TTSv2({ apiKey: 'test-key', encoding })).toThrow(/unsupported/);
  });

  it('rejects a compressed encoding passed to updateOptions', () => {
    const ttsv2 = new TTSv2({ apiKey: 'test-key' });
    expect(() => ttsv2.updateOptions({ encoding: 'mp3' })).toThrow(/unsupported/);
  });
});

const hasDeepgramTtsConfig = Boolean(process.env.DEEPGRAM_API_KEY && process.env.OPENAI_API_KEY);

if (hasDeepgramTtsConfig) {
  describe('Deepgram TTSv2 (Flux) live', async () => {
    await testTts(new TTSv2(), new STT());
  });
} else {
  describe('Deepgram TTSv2 (Flux) live', () => {
    it.skip('requires DEEPGRAM_API_KEY and OPENAI_API_KEY', () => {});
  });
}
