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
import { type ServerResponse, createServer } from 'node:http';
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
async function startFakeFluxServer(
  options: {
    failWith?: string;
    failFirstConnectionWith?: string;
    failFirstConnectionAfterAudioWith?: string;
  } = {},
): Promise<FakeFluxServer> {
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
    const connectionNumber = server.connections;
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'Connected', request_id: 'req-1' }));

    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; text?: string };
      if (message.type === 'Speak') {
        server.spoken.push(message.text ?? '');
        return;
      }
      if (message.type !== 'Flush') return;

      const failWith =
        options.failWith ?? (connectionNumber === 1 ? options.failFirstConnectionWith : undefined);
      if (failWith) {
        ws.send(JSON.stringify({ type: 'Error', description: failWith }));
        return;
      }

      // Audio first, then a failure: the turn dies after part of it has already played.
      if (connectionNumber === 1 && options.failFirstConnectionAfterAudioWith) {
        ws.send(JSON.stringify({ type: 'SpeechStarted' }));
        ws.send(Buffer.alloc(SAMPLE_RATE), { binary: true }); // 0.5s, several frames
        ws.send(
          JSON.stringify({ type: 'Error', description: options.failFirstConnectionAfterAudioWith }),
        );
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

describe('Deepgram TTSv2 (Flux) streaming retry', () => {
  let cleanup: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  // `SynthesizeStream.input` is created once and never reset between retry attempts, so
  // text consumed by attempt 1 is gone by attempt 2. Without the per-segment replay
  // buffer, the retry sent nothing at all and the stream ended successfully but silent.
  it('replays the segment text after a retryable failure', async () => {
    const server = await startFakeFluxServer({ failFirstConnectionWith: 'transient' });
    const ttsv2 = new TTSv2({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      sampleRate: SAMPLE_RATE,
    });
    cleanup.push(async () => {
      await ttsv2.close();
      await server.close();
    });

    const { audio, endOfStreamCount } = await synthesizeTurn(ttsv2, 'hello world', {
      ...DEFAULT_API_CONNECT_OPTIONS,
      maxRetry: 3,
      retryIntervalMs: 10,
    });

    expect(audio.length).toBeGreaterThan(0);
    expect(endOfStreamCount).toBe(1);
    // Once for the attempt that failed, once for the attempt that worked.
    expect(server.spoken).toEqual(['hello ', 'world ', 'hello ', 'world ']);
    expect(server.connections).toBe(2);
  });

  // Matches the Python base class, which refuses to retry once
  // `output_emitter.pushed_duration() > 0`. Replaying a segment whose opening words
  // already reached the listener would say them twice, which is worse than failing.
  it('does not replay a segment whose audio had already started playing', async () => {
    const server = await startFakeFluxServer({ failFirstConnectionAfterAudioWith: 'died midway' });
    const ttsv2 = new TTSv2({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      sampleRate: SAMPLE_RATE,
    });
    cleanup.push(async () => {
      await ttsv2.close();
      await server.close();
    });

    const errors: { error: Error; recoverable: boolean }[] = [];
    ttsv2.on('error', (ev) => errors.push({ error: ev.error, recoverable: ev.recoverable }));

    const { audio } = await synthesizeTurn(ttsv2, 'hello world', {
      ...DEFAULT_API_CONNECT_OPTIONS,
      maxRetry: 3,
      retryIntervalMs: 10,
    });

    // Some of the segment played before the failure...
    expect(audio.length).toBeGreaterThan(0);
    // ...so the words went out exactly once: no second attempt, no repeated speech.
    expect(server.spoken).toEqual(['hello ', 'world ']);
    expect(server.connections).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(false);
    expect(errors[0]!.error.message).toMatch(/already played/);
  });
});

describe('Deepgram TTSv2 (Flux) batch', () => {
  let cleanup: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  const startBatchServer = async (
    handler: (res: ServerResponse) => void,
  ): Promise<{ baseUrl: string; requests: () => number; close: () => Promise<void> }> => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests += 1;
      req.resume();
      req.on('end', () => handler(res));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests: () => requests,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  };

  // The batch path imported `request` from node:https unconditionally, so any non-https
  // baseUrl — the form the streaming path and these tests both use — turned into a TLS
  // handshake against a plain HTTP port.
  it('honours a plain http baseUrl instead of always dialling TLS', async () => {
    const body = Buffer.alloc(SAMPLE_RATE * 2); // 1s of 24kHz s16le
    const server = await startBatchServer((res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    });
    const ttsv2 = new TTSv2({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      sampleRate: SAMPLE_RATE,
    });
    cleanup.push(async () => {
      await ttsv2.close();
      await server.close();
    });

    const frame = await ttsv2.synthesize('hello').collect();
    expect(frame.samplesPerChannel).toBe(SAMPLE_RATE);
  });

  // Node reports a severed body as Error('aborted'), which the old filter discarded as
  // if it were a caller-side cancellation; `close` then flushed the partial buffer and
  // resolved, so a truncated response looked like a complete one.
  it('fails a truncated response instead of reporting a short synthesis as success', async () => {
    const server = await startBatchServer((res) => {
      res.writeHead(200, { 'Content-Length': String(SAMPLE_RATE * 2) }); // promises 1s
      res.write(Buffer.alloc(4800)); // delivers 100ms
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const ttsv2 = new TTSv2({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      sampleRate: SAMPLE_RATE,
    });
    cleanup.push(async () => {
      await ttsv2.close();
      await server.close();
    });

    // As on the streaming path, the base ChunkedStream swallows the throw to avoid an
    // unhandled rejection and reports it on the TTS `error` event, so that is what a
    // caller observes. Before the fix no error was raised at all and the short audio
    // was indistinguishable from a complete synthesis.
    const errors: { error: Error; recoverable: boolean }[] = [];
    ttsv2.on('error', (ev) => errors.push({ error: ev.error, recoverable: ev.recoverable }));

    const frame = await ttsv2
      .synthesize('hello', { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 })
      .collect();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.message).toMatch(/ended before the full body arrived/);
    expect(errors[0]!.recoverable).toBe(false);
    // 100ms of the 1s that was promised.
    expect(frame.samplesPerChannel).toBe(2400);
  });

  // Nothing has been emitted yet when the body is cut short before the first frame, so
  // the attempt is safe to repeat: no partial audio has escaped to be duplicated.
  it('retries a truncation that produced no audio', async () => {
    const body = Buffer.alloc(SAMPLE_RATE * 2);
    let attempt = 0;
    const server = await startBatchServer((res) => {
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(200, { 'Content-Length': String(body.length) });
        setTimeout(() => res.socket?.destroy(), 20); // headers only, no body
        return;
      }
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    });
    const ttsv2 = new TTSv2({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      sampleRate: SAMPLE_RATE,
    });
    cleanup.push(async () => {
      await ttsv2.close();
      await server.close();
    });

    const frame = await ttsv2
      .synthesize('hello', { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 3, retryIntervalMs: 10 })
      .collect();
    expect(frame.samplesPerChannel).toBe(SAMPLE_RATE);
    expect(server.requests()).toBe(2);
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
