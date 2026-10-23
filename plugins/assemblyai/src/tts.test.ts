// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  type tts,
} from '@livekit/agents';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  TTS,
  type TTSOptions,
  _MAX_REQUEST_CHARS,
  _MAX_UNBROKEN_CHARS,
  _WORD_BOUNDARIES_GRACE,
  _errorFromFrame,
  _splitRequestText,
} from './tts.js';

const KEEGAN = '987db62e-a2c2-569a-9c4d-82460cdea1bd';
const SAMPLE_RATE = 24000;
// 80 ms per Audio frame at 24 kHz pcm_s16le, as the service sends.
const FRAME_BYTES = (SAMPLE_RATE * 2 * 80) / 1000;
const CONN_OPTIONS: APIConnectOptions = {
  ...DEFAULT_API_CONNECT_OPTIONS,
  maxRetry: 0,
  timeoutMs: 5000,
};

type Json = Record<string, unknown>;
type FlushIdModel = 'live' | 'documented';

function errorFrame(code: number, text: string, fields: Json = {}): Json {
  return { type: 'Error', error_code: code, error: text, ...fields };
}

function pcm(numBytes: number, seed: number): Buffer {
  const result = Buffer.allocUnsafe(numBytes);
  for (let i = 0; i < numBytes / 2; i++) {
    result.writeInt16LE(((i * 97 + seed) % 2000) - 1000, i * 2);
  }
  return result;
}

interface Session {
  params: Record<string, string>;
  authorization?: string;
  received: Json[];
  ws: WebSocket;
}

interface FakeServerOptions {
  framesPerRequest?: number;
  frameDelay?: number;
  wordBoundaries?: boolean;
  dropWordBoundaries?: boolean | Set<number>;
  connectError?: Json;
  errorAfterBegin?: Json;
  tailFramesAfterCancel?: number;
  cancelledDelay?: number;
  lateWordBoundaries?: boolean;
  holdLateWordBoundaries?: boolean;
  errorAfterFlushDones?: [number, Json];
  beginDelay?: number;
  flushIdModel?: FlushIdModel;
  sessionSeconds?: number;
  wordBoundariesAfterCancelled?: boolean;
}

interface WorkItem {
  assigned?: number;
  text: string;
}

interface ServerState {
  flushId: number;
  timelineMs: number;
  inFlight: number;
}

/** Local stand-in for wss://tts.us.assemblyai.com/v1/ws. */
class FakeServer {
  framesPerRequest: number;
  frameDelay: number;
  cancelledDelay: number;
  readonly sessions: Session[] = [];
  readonly audioByRequest: Buffer[] = [];
  flushDones = 0;
  baseUrl = '';

  readonly #wordBoundaries: boolean;
  readonly #dropWordBoundaries: boolean | Set<number>;
  readonly #connectError?: Json;
  readonly #errorAfterBegin?: Json;
  readonly #tailFramesAfterCancel: number;
  readonly #lateWordBoundaries: boolean;
  readonly #holdLateWordBoundaries: boolean;
  readonly #errorAfterFlushDones?: [number, Json];
  readonly #beginDelay: number;
  readonly #flushIdModel: FlushIdModel;
  readonly #sessionSeconds: number;
  #wordBoundariesAfterCancelled: boolean;
  readonly #heldWordBoundaries: Json[] = [];
  #wss?: WebSocketServer;

  constructor(options: FakeServerOptions = {}) {
    this.framesPerRequest = options.framesPerRequest ?? 3;
    this.frameDelay = options.frameDelay ?? 0;
    this.#wordBoundaries = options.wordBoundaries ?? true;
    this.#dropWordBoundaries = options.dropWordBoundaries ?? false;
    this.#connectError = options.connectError;
    this.#errorAfterBegin = options.errorAfterBegin;
    this.#tailFramesAfterCancel = options.tailFramesAfterCancel ?? 0;
    this.cancelledDelay = options.cancelledDelay ?? 0;
    this.#lateWordBoundaries = options.lateWordBoundaries ?? false;
    this.#holdLateWordBoundaries = options.holdLateWordBoundaries ?? false;
    this.#errorAfterFlushDones = options.errorAfterFlushDones;
    this.#beginDelay = options.beginDelay ?? 0;
    this.#flushIdModel = options.flushIdModel ?? 'live';
    this.#sessionSeconds = options.sessionSeconds ?? 3600;
    this.#wordBoundariesAfterCancelled = options.wordBoundariesAfterCancelled ?? false;
  }

  async start(): Promise<this> {
    this.#wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/v1/ws' });
    this.#wss.on('connection', (ws, request) => void this.#handle(ws, request));
    await once(this.#wss, 'listening');
    const address = this.#wss.address() as AddressInfo;
    this.baseUrl = `ws://127.0.0.1:${address.port}`;
    return this;
  }

  async close(): Promise<void> {
    if (!this.#wss) return;
    for (const client of this.#wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.#wss!.close(() => resolve()));
    this.#wss = undefined;
  }

  frames(kind: string): Json[] {
    return this.sessions.flatMap((session) =>
      session.received.filter((message) => message.type === kind),
    );
  }

  async #handle(ws: WebSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? '/v1/ws', 'ws://localhost');
    const session: Session = {
      params: Object.fromEntries(url.searchParams),
      authorization:
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined,
      received: [],
      ws,
    };
    this.sessions.push(session);

    if (this.#connectError) {
      ws.send(JSON.stringify(this.#connectError));
      ws.close(Number(this.#connectError.error_code), 'See Error message for details');
      return;
    }

    await delay(this.#beginDelay);
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'Begin',
        id: `session-${this.sessions.length}`,
        expires_at: Math.floor(Date.now() / 1000 + this.#sessionSeconds),
        configuration: {
          voice: session.params.voice_id ?? 'jane',
          language: session.params.language ?? 'english',
          sample_rate: Number(session.params.sample_rate ?? SAMPLE_RATE),
          encoding: session.params.encoding,
          inactivity_timeout: null,
          word_boundaries: this.#wordBoundaries && session.params.word_boundaries === 'true',
          voice_clone: false,
          voice_clone_preprocess: false,
        },
      }),
    );

    if (this.#errorAfterBegin) {
      await delay(50);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(this.#errorAfterBegin));
        ws.close(Number(this.#errorAfterBegin.error_code), 'See Error message for details');
      }
      return;
    }

    const state: ServerState = { flushId: 0, timelineMs: 0, inFlight: 0 };
    let buffer: string[] = [];
    let queue: WorkItem[] = [];
    let workerAbort = new AbortController();
    let wakeWorker: (() => void) | undefined;
    let worker = this.#synthesize(
      ws,
      () => queue.shift(),
      state,
      workerAbort.signal,
      () =>
        new Promise<void>((resolve) => {
          wakeWorker = resolve;
        }),
    );

    let messageChain = Promise.resolve();
    ws.on('message', (raw) => {
      messageChain = messageChain.then(async () => {
        const data = JSON.parse(raw.toString()) as Json;
        session.received.push(data);
        switch (data.type) {
          case 'Generate':
            buffer.push(String(data.text));
            break;
          case 'Flush':
            queue.push({
              assigned: this.#flushIdModel === 'documented' ? state.flushId++ : undefined,
              text: buffer.join(''),
            });
            buffer = [];
            wakeWorker?.();
            wakeWorker = undefined;
            break;
          case 'Cancel': {
            buffer = [];
            queue = [];
            workerAbort.abort();
            await worker.catch(() => {});
            for (let i = 0; i < this.#tailFramesAfterCancel; i++) {
              this.#send(ws, {
                type: 'Audio',
                audio: pcm(FRAME_BYTES, 777).toString('base64'),
                flush_id: state.inFlight,
              });
              state.timelineMs += 80;
            }
            state.flushId++;
            await delay(this.cancelledDelay);
            this.#send(ws, { type: 'Cancelled', audio_duration_seconds: 0 });
            if (this.#wordBoundariesAfterCancelled) {
              this.#wordBoundariesAfterCancelled = false;
              for (const held of this.#heldWordBoundaries) this.#send(ws, held);
            }
            workerAbort = new AbortController();
            worker = this.#synthesize(
              ws,
              () => queue.shift(),
              state,
              workerAbort.signal,
              () =>
                new Promise<void>((resolve) => {
                  wakeWorker = resolve;
                }),
            );
            break;
          }
          case 'Terminate':
            workerAbort.abort();
            ws.close();
            break;
        }
      });
    });
    ws.once('close', () => workerAbort.abort());
  }

  async #synthesize(
    ws: WebSocket,
    take: () => WorkItem | undefined,
    state: ServerState,
    signal: AbortSignal,
    wait: () => Promise<void>,
  ): Promise<void> {
    let late: Json | undefined;
    while (!signal.aborted) {
      let item = take();
      if (!item) {
        if (late && !this.#holdLateWordBoundaries) {
          this.#send(ws, late);
          late = undefined;
        }
        await Promise.race([wait(), aborted(signal)]);
        if (signal.aborted) return;
        item = take();
        if (!item) continue;
      }

      const flushId = item.assigned ?? state.flushId;
      state.inFlight = flushId;
      const audioStartMs = state.timelineMs;
      const frames = Array.from({ length: this.framesPerRequest }, () => pcm(FRAME_BYTES, flushId));
      for (let i = 0; i < frames.length; i++) {
        await Promise.race([delay(this.frameDelay), aborted(signal)]);
        if (signal.aborted) return;
        this.#send(ws, {
          type: 'Audio',
          audio: frames[i]!.toString('base64'),
          flush_id: flushId,
        });
        state.timelineMs += 80;
        if (i === 0 && late) {
          this.#send(ws, late);
          late = undefined;
        }
      }
      this.audioByRequest.push(Buffer.concat(frames));
      const durationMs = this.framesPerRequest * 80;
      if (item.assigned === undefined) state.flushId++;
      this.flushDones++;
      this.#send(ws, {
        type: 'FlushDone',
        flush_id: flushId,
        audio_duration_ms: durationMs,
      });
      if (this.#errorAfterFlushDones?.[0] === this.flushDones) {
        const providerError = this.#errorAfterFlushDones[1];
        this.#send(ws, providerError);
        ws.close(Number(providerError.error_code), 'See Error message for details');
        return;
      }

      const dropped = this.#dropWordBoundaries;
      if (
        this.#wordBoundaries &&
        dropped !== true &&
        !(dropped instanceof Set && dropped.has(flushId))
      ) {
        const tokens = item.text.split(/\s+/).filter(Boolean);
        const step = Math.floor(durationMs / Math.max(tokens.length, 1));
        const boundaries: Json = {
          type: 'WordBoundaries',
          flush_id: flushId,
          audio_start_ms: audioStartMs,
          words: tokens.map((word, i) => ({
            word,
            start: audioStartMs + i * step,
            end: audioStartMs + (i + 1) * step,
            confidence: 0.9,
          })),
        };
        if (this.#wordBoundariesAfterCancelled) this.#heldWordBoundaries.push(boundaries);
        else if (this.#lateWordBoundaries) late = boundaries;
        else this.#send(ws, boundaries);
      }
    }
  }

  #send(ws: WebSocket, value: Json): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  }
}

function delay(ms: number): Promise<void> {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

async function withServer(
  options: FakeServerOptions,
  run: (server: FakeServer) => Promise<void>,
): Promise<void> {
  const server = await new FakeServer(options).start();
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function makeTts(server: FakeServer, options: Partial<TTSOptions> = {}): TTS {
  return new TTS({ apiKey: 'test-key', baseUrl: server.baseUrl, ...options });
}

interface SpeakResult {
  audio: Buffer;
  timed: NonNullable<tts.SynthesizedAudio['timedTranscripts']>;
  segments: Set<string>;
}

async function speak(engine: TTS, chunks: string[], maxRetry = 0): Promise<SpeakResult> {
  const stream = engine.stream({
    connOptions: { ...CONN_OPTIONS, maxRetry },
  });
  const audio: Buffer[] = [];
  const timed: SpeakResult['timed'] = [];
  const segments = new Set<string>();
  for (const chunk of chunks) stream.pushText(chunk);
  stream.endInput();
  try {
    for await (const event of stream) {
      if (typeof event === 'symbol') continue;
      audio.push(frameBuffer(event.frame.data));
      timed.push(...(event.timedTranscripts ?? []));
      segments.add(event.segmentId);
    }
    if (stream.error) throw stream.error;
    return { audio: Buffer.concat(audio), timed, segments };
  } finally {
    stream.close();
  }
}

function frameBuffer(data: Int16Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function stripPadding(audio: Buffer, expectedLength: number): Buffer {
  expect([...audio.subarray(expectedLength)].every((byte) => byte === 0)).toBe(true);
  return audio.subarray(0, expectedLength);
}

function timedText(timed: SpeakResult['timed']): string {
  return timed.map((word) => word.text).join('');
}

function optionsOf(engine: TTS): TTSOptions {
  return (engine as TTS & { _opts: TTSOptions })._opts;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AssemblyAI TTS configuration', () => {
  it('normalizes voice and language', () => {
    let engine = new TTS({ apiKey: 'k' });
    expect([optionsOf(engine).voice, optionsOf(engine).language, engine.model]).toEqual([
      KEEGAN,
      undefined,
      'assemblyai-tts-1',
    ]);

    engine = new TTS({ apiKey: 'k', voice: ' aai-vera ' });
    expect([optionsOf(engine).voice, optionsOf(engine).language]).toEqual(['aai-vera', undefined]);
    for (const language of ['spanish', 'Spanish', 'es', 'es-MX', 'spa']) {
      expect(optionsOf(new TTS({ apiKey: 'k', language })).language).toBe('spanish');
    }
    expect(optionsOf(new TTS({ apiKey: 'k', language: 'pt-BR' })).language).toBe('portuguese');
    expect(optionsOf(new TTS({ apiKey: 'k', language: 'ja' })).language).toBe('japanese');
    expect(optionsOf(new TTS({ apiKey: 'k', language: 'Klingon' })).language).toBe('klingon');
    expect(() => new TTS({ apiKey: 'k', voice: ' ' })).toThrow(/voice/i);
    expect(() => new TTS({ apiKey: 'k', language: '' })).toThrow(/language/i);
  });

  it('accepts custom voices and models', () => {
    const clone = '01a142a4-66f3-7315-b15f-668b6edfb595';
    let engine = new TTS({ apiKey: 'k', voice: ` ${clone} ` });
    expect([optionsOf(engine).voice, optionsOf(engine).language, engine.model]).toEqual([
      clone,
      undefined,
      'assemblyai-tts-1',
    ]);
    engine = new TTS({ apiKey: 'k', voice: 'my-voice', language: 'es', model: 'latest' });
    expect([optionsOf(engine).voice, optionsOf(engine).language, engine.model]).toEqual([
      'my-voice',
      'spanish',
      'latest',
    ]);
    expect(() => new TTS({ apiKey: 'k', model: ' ' })).toThrow(/model/i);
  });

  it('updates options', () => {
    const engine = new TTS({ apiKey: 'k', voice: 'aai-vera', language: 'es' });
    engine.updateOptions({ voice: 'clone', language: 'fr', model: 'latest' });
    expect([optionsOf(engine).voice, optionsOf(engine).language, engine.model]).toEqual([
      'clone',
      'french',
      'latest',
    ]);
    engine.updateOptions({ language: null });
    expect([optionsOf(engine).voice, optionsOf(engine).language]).toEqual(['clone', undefined]);
    expect(() => engine.updateOptions({ voice: ' ' })).toThrow(/voice/i);
  });

  it('rejects an invalid sample rate', () => {
    expect(() => new TTS({ apiKey: 'k', sampleRate: 12345 })).toThrow(/sample.?rate/i);
  });

  it('requires an API key or reads it from the environment', () => {
    vi.stubEnv('ASSEMBLYAI_API_KEY', '');
    expect(() => new TTS()).toThrow(/API key/i);
    vi.stubEnv('ASSEMBLYAI_API_KEY', 'from-env');
    expect(optionsOf(new TTS()).apiKey).toBe('from-env');
  });

  it('updates each option independently', () => {
    const engine = new TTS({ apiKey: 'k', voice: 'aai-anna' });
    engine.updateOptions({ language: 'fr' });
    expect([optionsOf(engine).voice, optionsOf(engine).language]).toEqual(['aai-anna', 'french']);
    engine.updateOptions({ voice: 'aai-linda-3' });
    expect([optionsOf(engine).voice, optionsOf(engine).language]).toEqual([
      'aai-linda-3',
      'french',
    ]);
  });

  it('splits request text at service limits', () => {
    expect(_splitRequestText('  hello there  ')).toEqual(['hello there']);
    expect(_splitRequestText('   ')).toEqual([]);
    const words = Array(1000).fill('word').join(' ');
    let pieces = _splitRequestText(words);
    expect(pieces.every((piece) => piece.length <= _MAX_REQUEST_CHARS)).toBe(true);
    expect(pieces.join(' ')).toBe(words);

    const blob = 'é'.repeat(2 * _MAX_UNBROKEN_CHARS + 5);
    pieces = _splitRequestText(blob);
    expect(pieces.every((piece) => piece.length <= _MAX_REQUEST_CHARS)).toBe(true);
    expect(pieces.flatMap((piece) => piece.split(/\s+/).map((run) => [...run].length))).toEqual([
      _MAX_UNBROKEN_CHARS,
      _MAX_UNBROKEN_CHARS,
      5,
    ]);
    const lines = Array(100)
      .fill('w'.repeat(_MAX_UNBROKEN_CHARS - 1))
      .join('\n');
    pieces = _splitRequestText(lines);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= _MAX_REQUEST_CHARS)).toBe(true);
    expect(pieces.flatMap((piece) => piece.split(/\s+/).map((run) => run.length))).toEqual(
      Array(100).fill(_MAX_UNBROKEN_CHARS - 1),
    );
  });
});

describe('AssemblyAI TTS streaming', () => {
  it('sends one request per sentence', async () => {
    await withServer({}, async (server) => {
      const engine = makeTts(server, { voice: 'aai-anna', language: 'en' });
      try {
        const { audio, timed, segments } = await speak(engine, [
          'Hi, thanks for ',
          'calling. How can I ',
          'help you today?',
        ]);
        const session = server.sessions[0]!;
        expect(session.authorization).toBe('test-key');
        expect(session.params).toEqual({
          model_id: 'assemblyai-tts-1',
          voice_id: 'aai-anna',
          language: 'english',
          sample_rate: '24000',
          encoding: 'pcm_s16le',
          word_boundaries: 'true',
        });
        expect(server.frames('Generate').map((frame) => frame.text)).toEqual([
          'Hi, thanks for calling.',
          'How can I help you today?',
        ]);
        expect(server.frames('Flush')).toHaveLength(2);
        const expected = Buffer.concat(server.audioByRequest);
        expect(stripPadding(audio, expected.length)).toEqual(expected);
        expect(segments.size).toBe(1);
        expect(timedText(timed)).toBe('Hi, thanks for calling. How can I help you today? ');
        const starts = timed.map((word) => word.startTime!);
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
        expect(starts[0]).toBeCloseTo(0);
        const secondRequestStart = server.framesPerRequest * 0.08;
        expect(timed[4]!.startTime).toBeCloseTo(secondRequestStart);
        expect(timed.at(-1)!.endTime).toBeCloseTo(2 * secondRequestStart);
      } finally {
        await engine.close();
      }
    });
  });

  it('reuses the connection and drops stale frames', async () => {
    await withServer({}, async (server) => {
      const engine = makeTts(server);
      try {
        const firstResult = await speak(engine, ['First reply here.']);
        const secondResult = await speak(engine, ['Second reply here.']);
        expect(server.sessions).toHaveLength(1);
        expect(server.frames('Cancel')).toEqual([]);
        expect(stripPadding(firstResult.audio, server.audioByRequest[0]!.length)).toEqual(
          server.audioByRequest[0],
        );
        expect(stripPadding(secondResult.audio, server.audioByRequest[1]!.length)).toEqual(
          server.audioByRequest[1],
        );
        expect(timedText(firstResult.timed)).toBe('First reply here. ');
        expect(timedText(secondResult.timed)).toBe('Second reply here. ');
        expect(secondResult.timed[0]!.startTime).toBeCloseTo(0);
      } finally {
        await engine.close();
      }
    });
  });

  it.each<FlushIdModel>(['live', 'documented'])(
    'cancels an interrupted stream and frees the socket (%s ids)',
    async (flushIdModel) => {
      await withServer({ framesPerRequest: 40, frameDelay: 10, flushIdModel }, async (server) => {
        const engine = makeTts(server);
        try {
          const stream = engine.stream({ connOptions: CONN_OPTIONS });
          stream.pushText('This reply gets interrupted by the user.');
          stream.endInput();
          for await (const event of stream) {
            if (typeof event !== 'symbol') break;
          }
          stream.close();
          await stream.done.await;
          server.framesPerRequest = 2;
          server.frameDelay = 0;
          const result = await speak(engine, ['After the interruption.']);
          expect(server.sessions).toHaveLength(1);
          expect(server.frames('Cancel')).toHaveLength(1);
          const expected = server.audioByRequest.at(-1)!;
          expect(stripPadding(result.audio, expected.length)).toEqual(expected);
          expect(timedText(result.timed)).toBe('After the interruption. ');
        } finally {
          await engine.close();
        }
      });
    },
  );

  it('falls back to sentence timing when word boundaries are missing', async () => {
    await withServer({ dropWordBoundaries: true }, async (server) => {
      const engine = makeTts(server);
      try {
        const { timed } = await speak(engine, [
          'The first sentence is right here. The second one is over there.',
        ]);
        expect(timed.map((value) => value.text)).toEqual([
          'The first sentence is right here. ',
          'The second one is over there. ',
        ]);
        expect(timed[0]!.startTime).toBeCloseTo(0);
        expect(timed[1]!.startTime).toBeCloseTo(server.framesPerRequest * 0.08);
      } finally {
        await engine.close();
      }
    });
  });

  it('keeps transcript order when one request misses word boundaries', async () => {
    await withServer({ dropWordBoundaries: new Set([0]) }, async (server) => {
      const engine = makeTts(server);
      try {
        const { timed } = await speak(engine, [
          'The first sentence is right here. The second one is over there.',
        ]);
        expect(timed.map((value) => value.text)).toEqual([
          'The first sentence is right here. ',
          ...'The second one is over there.'.split(' ').map((word) => `${word} `),
        ]);
        const starts = timed.map((word) => word.startTime!);
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
      } finally {
        await engine.close();
      }
    });
  });

  it('paces per sentence when the session has no word boundaries', async () => {
    await withServer({ wordBoundaries: false }, async (server) => {
      const engine = makeTts(server);
      try {
        const { timed } = await speak(engine, [
          'The first sentence is right here. The second one is over there.',
        ]);
        expect(timed.map((value) => value.text)).toEqual([
          'The first sentence is right here. ',
          'The second one is over there. ',
        ]);
      } finally {
        await engine.close();
      }
    });
  });

  it('can disable word timestamps', async () => {
    await withServer({}, async (server) => {
      const engine = makeTts(server, { wordTimestamps: false });
      try {
        expect(engine.capabilities.alignedTranscript).toBe(false);
        const { timed } = await speak(engine, ['Nothing timed here.']);
        expect(server.sessions[0]!.params.word_boundaries).toBe('false');
        expect(timed).toEqual([]);
      } finally {
        await engine.close();
      }
    });
  });

  it('supports one-shot synthesis', async () => {
    await withServer({}, async (server) => {
      const engine = makeTts(server);
      try {
        const frame = await engine.synthesize('A one-shot synthesis.', CONN_OPTIONS).collect();
        expect(frame.sampleRate).toBe(SAMPLE_RATE);
        const expected = server.audioByRequest[0]!;
        expect(stripPadding(frameBuffer(frame.data), expected.length)).toEqual(expected);
      } finally {
        await engine.close();
      }
    });
  });

  it('splits a long sentence into requests', async () => {
    const text = `${Array(900).fill('word').join(' ')}.`;
    await withServer({ framesPerRequest: 1 }, async (server) => {
      const engine = makeTts(server);
      try {
        await speak(engine, [text]);
        const generates = server.frames('Generate').map((frame) => String(frame.text));
        expect(generates).toHaveLength(3);
        expect(generates.every((value) => value.length <= _MAX_REQUEST_CHARS)).toBe(true);
        expect(server.frames('Flush')).toHaveLength(3);
      } finally {
        await engine.close();
      }
    });
  });

  it('opens a new session after options change', async () => {
    await withServer({}, async (server) => {
      const engine = makeTts(server);
      try {
        await speak(engine, ['Hello.']);
        engine.updateOptions({ voice: 'aai-paul', language: 'it' });
        await speak(engine, ['Ciao.']);
        expect(server.sessions.map(({ params }) => [params.voice_id, params.language])).toEqual([
          [KEEGAN, undefined],
          ['aai-paul', 'italian'],
        ]);
      } finally {
        await engine.close();
      }
    });
  });

  it('sends voice and model when connecting', async () => {
    await withServer({}, async (server) => {
      const engine = makeTts(server, { voice: 'clone', model: 'some-model' });
      try {
        await speak(engine, ['Hello.']);
        engine.updateOptions({ voice: 'aai-jane', model: 'assemblyai-tts-1' });
        await speak(engine, ['Hello again.']);
        expect(
          server.sessions.map(({ params }) => [
            params.voice,
            params.voice_id,
            params.language,
            params.model_id,
          ]),
        ).toEqual([
          [undefined, 'clone', undefined, 'some-model'],
          [undefined, 'aai-jane', undefined, 'assemblyai-tts-1'],
        ]);
      } finally {
        await engine.close();
      }
    });
  });

  it('replaces a socket closed while idle', async () => {
    await withServer({}, async (server) => {
      const engine = makeTts(server);
      try {
        await speak(engine, ['Hello.']);
        server.sessions[0]!.ws.send(
          JSON.stringify(
            errorFrame(3008, 'Session reached its maximum duration; open a new connection', {
              error_type: 'session_expired',
              retryable: true,
            }),
          ),
        );
        server.sessions[0]!.ws.close(3008);
        await delay(50);
        const { audio } = await speak(engine, ['Still here.']);
        expect(server.sessions).toHaveLength(2);
        expect(audio.length).toBeGreaterThan(0);
      } finally {
        await engine.close();
      }
    });
  });

  it.each<FlushIdModel>(['live', 'documented'])(
    'waits for Cancelled and drops tail audio (%s ids)',
    async (flushIdModel) => {
      await interruptedFollowupCase(
        {
          framesPerRequest: 40,
          frameDelay: 10,
          tailFramesAfterCancel: 3,
          cancelledDelay: 200,
          flushIdModel,
        },
        'After the interruption.',
      );
    },
  );

  it.each<FlushIdModel>(['live', 'documented'])(
    'handles a second interrupt before the first Cancelled (%s ids)',
    async (flushIdModel) => {
      await withServer(
        { framesPerRequest: 40, frameDelay: 10, cancelledDelay: 300, flushIdModel },
        async (server) => {
          const engine = makeTts(server);
          try {
            let stream = engine.stream({ connOptions: CONN_OPTIONS });
            stream.pushText('The first reply gets interrupted.');
            stream.endInput();
            for await (const event of stream) if (typeof event !== 'symbol') break;
            stream.close();
            await stream.done.await;
            stream = engine.stream({ connOptions: CONN_OPTIONS });
            stream.pushText('The second reply never gets a word in.');
            stream.endInput();
            await delay(100);
            stream.close();
            await stream.done.await;
            server.framesPerRequest = 2;
            server.frameDelay = 0;
            server.cancelledDelay = 0;
            const result = await speak(engine, ['The third reply is heard.']);
            expect(server.sessions).toHaveLength(1);
            expect(server.frames('Cancel')).toHaveLength(2);
            const expected = server.audioByRequest.at(-1)!;
            expect(stripPadding(result.audio, expected.length)).toEqual(expected);
            expect(timedText(result.timed)).toBe('The third reply is heard. ');
          } finally {
            await engine.close();
          }
        },
      );
    },
  );

  it.each<FlushIdModel>(['live', 'documented'])(
    'drops word boundaries arriving after Cancelled (%s ids)',
    async (flushIdModel) => {
      await cancelAfterCompletedRequestCase({
        wordBoundariesAfterCancelled: true,
        flushIdModel,
      });
    },
  );

  it.each<FlushIdModel>(['live', 'documented'])(
    'cancels after some requests completed (%s ids)',
    async (flushIdModel) => {
      await cancelAfterCompletedRequestCase({ flushIdModel });
    },
  );

  it('reads word timings while waiting for more text', async () => {
    await withServer({}, async (server) => {
      const engine = makeTts(server);
      const stream = engine.stream({ connOptions: CONN_OPTIONS });
      const timed: SpeakResult['timed'] = [];
      try {
        stream.pushText('The first sentence. ');
        stream.flush();
        await Promise.race([
          (async () => {
            for await (const event of stream) {
              if (typeof event === 'symbol') continue;
              timed.push(...(event.timedTranscripts ?? []));
              if (timedText(timed) === 'The first sentence. ') return;
            }
          })(),
          delay(2000).then(() => {
            throw new Error('timed out waiting for word boundaries');
          }),
        ]);
        stream.endInput();
        expect(timed.every((word) => typeof word.startTime === 'number')).toBe(true);
        expect(timed).toHaveLength(3);
      } finally {
        stream.close();
        await engine.close();
      }
    });
  });

  it('ignores word boundaries from the previous stream', async () => {
    await withServer({ lateWordBoundaries: true, holdLateWordBoundaries: true }, async (server) => {
      const engine = makeTts(server);
      try {
        await speak(engine, ['The first reply.']);
        const { timed } = await speak(engine, ['The second reply.']);
        expect(server.sessions).toHaveLength(1);
        expect(timedText(timed)).toBe('The second reply. ');
      } finally {
        await engine.close();
      }
    });
  });

  it('handles word boundaries trailing the next request audio', async () => {
    await withServer({ lateWordBoundaries: true }, async (server) => {
      const engine = makeTts(server);
      try {
        const { timed } = await speak(engine, [
          'The first sentence is right here. The second one is over there. And a third.',
        ]);
        expect(timedText(timed)).toBe(
          'The first sentence is right here. The second one is over there. And a third. ',
        );
        const starts = timed.map((word) => word.startTime!);
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
        const requestDuration = server.framesPerRequest * 0.08;
        expect(timed[6]!.startTime).toBeCloseTo(requestDuration);
        expect(timed.at(-1)!.endTime).toBeCloseTo(3 * requestDuration);
      } finally {
        await engine.close();
      }
    });
  });

  it('does not hold back audio while word boundaries are missing', async () => {
    await withServer({ dropWordBoundaries: true }, async (server) => {
      const engine = makeTts(server);
      const stream = engine.stream({ connOptions: CONN_OPTIONS });
      try {
        const started = performance.now();
        stream.pushText('A short reply that ends the turn.');
        stream.endInput();
        let received = 0;
        let allAudioAt: number | undefined;
        for await (const event of stream) {
          if (typeof event === 'symbol') continue;
          received += event.frame.data.byteLength;
          if (allAudioAt === undefined && received >= server.framesPerRequest * FRAME_BYTES) {
            allAudioAt = performance.now() - started;
          }
        }
        expect(allAudioAt).toBeDefined();
        expect(allAudioAt!).toBeLessThan(_WORD_BOUNDARIES_GRACE / 2);
      } finally {
        stream.close();
        await engine.close();
      }
    });
  });

  it('leaks no work when interrupted while connecting', async () => {
    await withServer({ beginDelay: 300 }, async (server) => {
      const engine = makeTts(server, { textPacing: true });
      try {
        for (let i = 0; i < 3; i++) {
          const stream = engine.stream({ connOptions: CONN_OPTIONS });
          stream.pushText('Interrupted before the session opens.');
          await delay(50);
          stream.close();
          await stream.done.await;
        }
      } finally {
        await engine.close();
      }
      for (
        let i = 0;
        i < 20 && server.sessions.some(({ ws }) => ws.readyState === WebSocket.OPEN);
        i++
      ) {
        await delay(10);
      }
      expect(server.sessions.every(({ ws }) => ws.readyState !== WebSocket.OPEN)).toBe(true);
    });
  });
});

async function interruptedFollowupCase(
  options: FakeServerOptions,
  followup: string,
): Promise<void> {
  await withServer(options, async (server) => {
    const engine = makeTts(server);
    try {
      const stream = engine.stream({ connOptions: CONN_OPTIONS });
      stream.pushText('This reply gets interrupted by the user.');
      stream.endInput();
      for await (const event of stream) if (typeof event !== 'symbol') break;
      stream.close();
      await stream.done.await;
      server.framesPerRequest = 2;
      server.frameDelay = 0;
      const result = await speak(engine, [followup]);
      expect(server.sessions).toHaveLength(1);
      const expected = server.audioByRequest.at(-1)!;
      expect(stripPadding(result.audio, expected.length)).toEqual(expected);
      expect(timedText(result.timed)).toBe(`${followup} `);
      expect(result.timed[0]!.startTime).toBeCloseTo(0);
    } finally {
      await engine.close();
    }
  });
}

async function cancelAfterCompletedRequestCase(options: FakeServerOptions): Promise<void> {
  await withServer({ framesPerRequest: 10, frameDelay: 30, ...options }, async (server) => {
    const engine = makeTts(server);
    try {
      const stream = engine.stream({ connOptions: CONN_OPTIONS });
      stream.pushText('The first sentence finishes playing. The second one is cut off.');
      stream.endInput();
      let received = 0;
      for await (const event of stream) {
        if (typeof event === 'symbol') continue;
        received += event.frame.data.byteLength;
        if (received > 12 * FRAME_BYTES) break;
      }
      stream.close();
      await stream.done.await;
      server.framesPerRequest = 2;
      server.frameDelay = 0;
      const result = await speak(engine, ['A fresh reply.']);
      expect(server.frames('Cancel')).toHaveLength(1);
      const expected = server.audioByRequest.at(-1)!;
      expect(stripPadding(result.audio, expected.length)).toEqual(expected);
      expect(timedText(result.timed)).toBe('A fresh reply. ');
      if (options.wordBoundariesAfterCancelled) {
        expect(result.timed[0]!.startTime).toBeCloseTo(0);
      }
    } finally {
      await engine.close();
    }
  });
}

describe('AssemblyAI TTS errors', () => {
  it('does not retry rejected credentials', async () => {
    await withServer(
      { connectError: errorFrame(1008, 'Unauthorized: Invalid API key') },
      async (server) => {
        const engine = makeTts(server);
        try {
          const error = await caught(() => speak(engine, ['Hello.'], 2));
          expect(error).toBeInstanceOf(APIStatusError);
          expect((error as APIStatusError).statusCode).toBe(1008);
          expect((error as APIStatusError).retryable).toBe(false);
          expect(error.message).toContain('Invalid API key');
          expect(server.sessions).toHaveLength(1);
        } finally {
          await engine.close();
        }
      },
    );
  });

  it('reports an unsupported voice error after Begin', async () => {
    await withServer(
      {
        errorAfterBegin: errorFrame(
          3006,
          "Unsupported preset voice 'nobody'. Available on this connection: ['jane'].",
        ),
      },
      async (server) => {
        const engine = makeTts(server, { voice: 'nobody' });
        try {
          const error = await caught(() => speak(engine, ['Hello.'], 2));
          expect(error).toBeInstanceOf(APIStatusError);
          expect((error as APIStatusError).statusCode).toBe(3006);
          expect((error as APIStatusError).retryable).toBe(false);
          expect(server.sessions).toHaveLength(1);
        } finally {
          await engine.close();
        }
      },
    );
  });

  it('retries transient errors on a new session', async () => {
    await withServer(
      {
        connectError: errorFrame(
          3005,
          'The TTS service is temporarily unavailable; please reconnect and retry',
        ),
      },
      async (server) => {
        const engine = makeTts(server);
        try {
          const error = await caught(() => speak(engine, ['Hello.'], 1));
          expect(error).toBeInstanceOf(APIStatusError);
          expect((error as APIStatusError).retryable).toBe(true);
          expect(server.sessions).toHaveLength(2);
        } finally {
          await engine.close();
        }
      },
    );
  });

  it.each([
    [errorFrame(3006, 'Generate text is 2500 characters, over the limit.'), false],
    [errorFrame(3010, 'Input text rate exceeded'), false],
    [errorFrame(3009, 'Too many sessions opened for this account'), true],
    [errorFrame(3012, 'The requested voice was not found.'), false],
    [errorFrame(3014, 'Voice v has no ready pairing with model m'), false],
    [errorFrame(3006, 'reworded', { error_type: 'inactivity_timeout', retryable: true }), true],
    [
      errorFrame(3005, 'The server is out of room', { error_type: 'at_capacity', retryable: true }),
      true,
    ],
    [
      errorFrame(3011, 'Audio consumption too slow', {
        error_type: 'audio_backlog',
        retryable: false,
      }),
      false,
    ],
    [
      errorFrame(4321, 'A code added later', { error_type: 'something_new', retryable: false }),
      false,
    ],
  ] as const)('classifies error retryability %#', (frame, retryable) => {
    const error = _errorFromFrame(frame, 's');
    expect(error.retryable).toBe(retryable);
    expect(error.requestId).toBe('s');
    if (frame.error_type) expect(error.message).toContain(String(frame.error_type));
  });

  it('honors retry_after before opening the next session', async () => {
    await withServer(
      {
        connectError: errorFrame(3009, 'Too many sessions; retry in 1 s.', {
          error_type: 'rate_limited',
          retryable: true,
          retry_after_seconds: 0.5,
        }),
      },
      async (server) => {
        const engine = makeTts(server);
        try {
          const started = performance.now();
          const error = await caught(() => speak(engine, ['Hello.'], 1));
          expect(error).toBeInstanceOf(APIStatusError);
          expect(server.sessions).toHaveLength(2);
          expect(performance.now() - started).toBeGreaterThanOrEqual(500);
        } finally {
          await engine.close();
        }
      },
    );
  });

  it('stops retries when retry_after exceeds the timeout', async () => {
    await withServer(
      {
        connectError: errorFrame(3009, 'Too many sessions; retry in 30 s.', {
          error_type: 'rate_limited',
          retryable: true,
          retry_after_seconds: 30,
        }),
      },
      async (server) => {
        const engine = makeTts(server);
        try {
          const error = await caught(() => speak(engine, ['Hello.'], 2));
          expect(error).toBeInstanceOf(APIConnectionError);
          expect((error as APIConnectionError).retryable).toBe(false);
          expect(server.sessions).toHaveLength(1);
        } finally {
          await engine.close();
        }
      },
    );
  });

  it('does not replace an unusable new session in a loop', async () => {
    await withServer({ sessionSeconds: -1 }, async (server) => {
      const engine = makeTts(server);
      try {
        const error = await caught(() => speak(engine, ['Hello.'], 1));
        expect(error).toBeInstanceOf(APIConnectionError);
        expect(error.message).toMatch(/unusable as soon as it opened/i);
        expect(server.sessions).toHaveLength(2);
      } finally {
        await engine.close();
      }
    });
  });

  it('uses a short session', async () => {
    await withServer({ sessionSeconds: 60 }, async (server) => {
      const engine = makeTts(server);
      try {
        const { audio } = await speak(engine, ['Hello.']);
        expect(server.sessions).toHaveLength(1);
        expect(audio.length).toBeGreaterThan(0);
      } finally {
        await engine.close();
      }
    });
  });

  it('sends an unbroken run in speakable pieces', async () => {
    const digest = 'f'.repeat(1900);
    await withServer({ framesPerRequest: 1 }, async (server) => {
      const engine = makeTts(server);
      try {
        await speak(engine, [`The digest is ${digest}.`]);
        const runs = server.frames('Generate').flatMap((frame) => String(frame.text).split(/\s+/));
        expect(Math.max(...runs.map((run) => run.length))).toBeLessThanOrEqual(_MAX_UNBROKEN_CHARS);
      } finally {
        await engine.close();
      }
    });
  });

  it('raises a mid-stream error after partial audio without retrying', async () => {
    const providerError = errorFrame(
      3005,
      'The TTS service is temporarily unavailable; please reconnect and retry',
    );
    await withServer({ errorAfterFlushDones: [1, providerError] }, async (server) => {
      const engine = makeTts(server);
      try {
        const error = await caught(() =>
          speak(engine, ['The first sentence is right here. The second one is over there.'], 2),
        );
        expect(error).toBeInstanceOf(APIStatusError);
        expect((error as APIStatusError).statusCode).toBe(3005);
        expect((error as APIStatusError).retryable).toBe(true);
        expect(server.sessions).toHaveLength(1);
      } finally {
        await engine.close();
      }
    });
  });
});

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected operation to fail');
}
