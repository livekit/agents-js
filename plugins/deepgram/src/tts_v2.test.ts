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
import { type FluxTTSEncoding, TTSv2 } from './tts_v2.js';

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

  // The whole reason this plugin carries a StreamChannel of WordStreams and a runSegments
  // loop: the framework flushes between sentences and keeps pushing onto the same stream.
  // This is also the only test that pins the ordering invariant keeping that loop from
  // deadlocking — `wordStream.endInput()` for segment N runs before the (backpressured)
  // `segments.write()` for segment N+1, so segment N can always complete.
  it('synthesizes each flushed segment on the same socket', async () => {
    const { server, ttsv2 } = await setup();

    const stream = ttsv2.stream();
    stream.pushText('first segment');
    stream.flush();
    stream.pushText('second segment');
    stream.endInput();

    let segments = 0;
    const finals: tts.SynthesizedAudio[] = [];
    try {
      for await (const event of stream) {
        if (event === tts.SynthesizeStream.END_OF_STREAM) {
          if (++segments === 2) break;
          continue;
        }
        if (event.final) finals.push(event);
      }
    } finally {
      stream.close();
    }

    expect(segments).toBe(2);
    expect(finals).toHaveLength(2);
    expect(new Set(finals.map((f) => f.segmentId)).size).toBe(2);
    expect(server.connections).toBe(1);
    expect(server.spoken).toEqual(['first ', 'segment ', 'second ', 'segment ']);
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
  // `encoding` is typed to the single supported value, so these casts are what a
  // JavaScript caller (or a stale build) would do; TypeScript callers get a compile error
  // instead, which is the point of the narrow type.
  const invalid = (encoding: string) => encoding as FluxTTSEncoding;

  // AudioByteStream expects raw PCM and this plugin has no decoder, so a compressed
  // encoding must fail loudly rather than emit garbage frames.
  it.each(['mp3', 'opus', 'flac', 'aac', 'mulaw'])('rejects %s', (encoding) => {
    expect(() => new TTSv2({ apiKey: 'test-key', encoding: invalid(encoding) })).toThrow(
      /unsupported/,
    );
  });

  it('rejects a compressed encoding passed to updateOptions', () => {
    const ttsv2 = new TTSv2({ apiKey: 'test-key' });
    expect(() => ttsv2.updateOptions({ encoding: invalid('mp3') })).toThrow(/unsupported/);
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
