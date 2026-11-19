// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any, turbo/no-undeclared-env-vars */
import { APIConnectionError, APIStatusError, log, stt } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { STT, type STTOptions, _cleanTranscript } from './stt.js';

const API_KEY = 'test-key';
const NO_RETRY = { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 };
const FAST_RETRY = { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 };

interface LiveSession {
  headers: IncomingMessage['headers'];
  protocol: string;
  updates: Record<string, any>[];
  controls: Record<string, any>[];
  audio: Buffer[];
  ws: WebSocket;
}

interface FastRequest {
  headers: IncomingMessage['headers'];
  fields: Record<string, any>;
  filename: string;
  contentType: string;
  audio: Buffer;
}

class FakeScribe {
  server?: Server;
  wss = new WebSocketServer({ noServer: true });
  sessions: LiveSession[] = [];
  fastRequests: FastRequest[] = [];
  fastStatus = 200;
  fastRawBody?: string;
  fastBody: Record<string, any> = {
    request_id: 'req_1',
    result: {
      text_display: 'Hi there! What is the capital of France?',
      segments: [{ start: 0.2, end: 2.7, speaker: 'speaker_1', text: 'Hi there!' }],
    },
  };
  rejectHandshake = false;
  handshakeTrackingIds: string[] = [];
  rejectUpdate?: Record<string, any>[];
  onStart?: (session: LiveSession) => void | Promise<void>;
  onAudio?: (session: LiveSession) => void | Promise<void>;
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.#http(request, response));
    this.server.on('upgrade', (request, socket, head) => {
      this.handshakeTrackingIds.push(String(request.headers['x-zm-trackingid'] ?? ''));
      if (this.rejectHandshake) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n');
        socket.end('{"message":"Invalid Access token"}');
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) =>
        this.wss.emit('connection', ws, request),
      );
    });
    this.wss.on('connection', (ws, request) => {
      const session: LiveSession = {
        headers: request.headers,
        protocol: ws.protocol,
        updates: [],
        controls: [],
        audio: [],
        ws,
      };
      this.sessions.push(session);
      ws.on('message', (data, binary) => void this.#message(session, data, binary));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const session of this.sessions) session.ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  urls(): Pick<STTOptions, 'liveUrl' | 'fastUrl'> {
    return {
      liveUrl: this.baseUrl.replace('http:', 'ws:') + '/live',
      fastUrl: this.baseUrl + '/transcribe',
    };
  }

  async #message(session: LiveSession, data: RawData, binary: boolean): Promise<void> {
    if (binary) {
      session.audio.push(Buffer.from(data as Buffer));
      await this.onAudio?.(session);
      return;
    }
    const event = JSON.parse(data.toString()) as Record<string, any>;
    if (event.type === 'session.update') {
      session.updates.push(event);
      if (this.rejectUpdate) {
        for (const error of this.rejectUpdate) {
          session.ws.send(JSON.stringify({ type: 'error', error }));
        }
        session.ws.close();
        return;
      }
      session.ws.send(JSON.stringify({ type: 'session.updated' }));
      await this.onStart?.(session);
    } else if (event.type === 'session.close') {
      session.controls.push(event);
      session.ws.send(JSON.stringify({ type: 'session.closed', reason: 'client_close' }));
      session.ws.close();
    } else {
      session.controls.push(event);
    }
  }

  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== '/transcribe') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const parsed = await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': request.headers['content-type']! },
    }).formData();
    const file = parsed.get('file') as File;
    const fields: Record<string, any> = {};
    for (const [key, value] of parsed.entries()) {
      if (key !== 'file') fields[key] = JSON.parse(String(value));
    }
    this.fastRequests.push({
      headers: request.headers,
      fields,
      filename: file.name,
      contentType: file.type,
      audio: Buffer.from(await file.arrayBuffer()),
    });
    response.writeHead(this.fastStatus, {
      'content-type': 'application/json',
      'x-zm-trackingid': String(request.headers['x-zm-trackingid']),
    });
    response.end(this.fastRawBody ?? JSON.stringify(this.fastBody));
  }
}

function frames(seconds: number, sampleRate = 16000, channels = 1): AudioFrame[] {
  const samples = (sampleRate * 20) / 1000;
  return Array.from(
    { length: (seconds * 1000) / 20 },
    () => new AudioFrame(new Int16Array(samples * channels), sampleRate, channels, samples),
  );
}

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= end) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runStream(
  stream: ReturnType<STT['stream']>,
  input: AudioFrame[],
): Promise<stt.SpeechEvent[]> {
  const events: stt.SpeechEvent[] = [];
  const collect = (async () => {
    for await (const event of stream) events.push(event);
  })();
  for (const frame of input) stream.pushFrame(frame);
  stream.endInput();
  await collect;
  stream.close();
  return events;
}

function makeSTT(fake: FakeScribe, options: Partial<STTOptions> = {}): STT {
  return new STT({ apiKey: API_KEY, ...fake.urls(), ...options });
}

describe('construction and options', () => {
  it('requires and reads ZOOM_AI_API_KEY', () => {
    const previous = process.env.ZOOM_AI_API_KEY;
    delete process.env.ZOOM_AI_API_KEY;
    expect(() => new STT()).toThrow('ZOOM_AI_API_KEY');
    process.env.ZOOM_AI_API_KEY = 'env-key';
    expect(() => new STT()).not.toThrow();
    if (previous === undefined) delete process.env.ZOOM_AI_API_KEY;
    else process.env.ZOOM_AI_API_KEY = previous;
  });

  it('reports capabilities, provider, and model', () => {
    const live = new STT({ apiKey: API_KEY });
    const fast = new STT({ apiKey: API_KEY, mode: 'fast', diarization: true });
    expect([live.provider, live.model, fast.model]).toEqual(['Zoom', 'scribe-live', 'scribe-fast']);
    expect(live.capabilities).toMatchObject({ streaming: true, interimResults: false });
    expect(fast.capabilities).toMatchObject({ streaming: false, diarization: true });
    expect(live.capabilities).toMatchObject({ alignedTranscript: false, diarization: false });
    expect(new STT({ apiKey: API_KEY, mode: 'fast' }).capabilities.alignedTranscript).toBe(false);
    expect(
      new STT({ apiKey: API_KEY, mode: 'fast', wordTimeOffsets: true }).capabilities
        .alignedTranscript,
    ).toBe('word');
    expect(
      new STT({
        apiKey: API_KEY,
        extraKwargs: { config: { diarization: true } },
      }).capabilities.diarization,
    ).toBe(true);
    expect(new STT({ apiKey: API_KEY, model: 'zoom-scribe-en-pro' }).model).toBe(
      'zoom-scribe-en-pro',
    );
  });

  it.each([
    ['en', 'en-US'],
    ['en-us', 'en-US'],
    ['en_US', 'en-US'],
    ['english', 'en-US'],
    ['ja', 'ja-JP'],
    ['pt-PT', 'pt-PT'],
    ['ko', 'ko-KR'],
    ['ko-KR', 'ko-KR'],
    ['nl', 'nl-NL'],
    ['fil', 'tl-PH'],
    ['tl-PH', 'tl-PH'],
    ['yue', 'zh-HK'],
    ['zh-hk', 'zh-HK'],
    ['en-GB', 'en-US'],
    ['fr-CA', 'fr-FR'],
    ['es-MX', 'es-ES'],
    ['xx', 'xx'],
    ['xx-YY', 'xx-YY'],
    ['sw-KE', 'sw-KE'],
  ])('maps %s to %s', async (given, expected) => {
    const fake = new FakeScribe();
    await fake.start();
    try {
      const zoom = makeSTT(fake, { language: given });
      await runStream(zoom.stream({ connOptions: NO_RETRY }), []);
      expect(fake.sessions[0]!.updates[0]!.language).toBe(expected);
    } finally {
      await fake.close();
    }
  });

  it('maps languages supplied through updateOptions', async () => {
    const fake = new FakeScribe();
    await fake.start();
    try {
      const zoom = makeSTT(fake);
      const stream = zoom.stream({ connOptions: NO_RETRY });
      await waitUntil(() => fake.sessions.length === 1);
      zoom.updateOptions({ language: 'fr-CA' });
      await waitUntil(() => fake.sessions.length === 2);
      await runStream(stream, []);
      expect(fake.sessions[1]!.updates[0]!.language).toBe('fr-FR');
    } finally {
      await fake.close();
    }
  });

  it.each([
    ['[Speaker 1] Hi. [Speaker 2] Hello.', 'Hi. Hello.'],
    ['[speaker_1] Hi.', 'Hi.'],
    ['[Speaker 1L] Hi. [Speaker 1R] Hello.', 'Hi. Hello.'],
    ['[spk_0] Hi. [channel1] Hello.', 'Hi. Hello.'],
    ['Keep [brackets] and [Speaker] as they are.', 'Keep [brackets] and [Speaker] as they are.'],
  ])('cleans Scribe tags', (text, expected) => {
    expect(_cleanTranscript(text)).toBe(expected);
  });

  it('rejects unsupported mode, non-object extraKwargs, invalid base URLs, and fast streams', () => {
    expect(() => new STT({ apiKey: API_KEY, mode: 'Live' as 'live' })).toThrow('mode');
    expect(() => new STT({ apiKey: API_KEY, extraKwargs: [] as never })).toThrow('extraKwargs');
    for (const baseUrl of ['wss://api.zoom.us/x', 'api.zoom.us/x', 'https']) {
      expect(() => new STT({ apiKey: API_KEY, baseUrl })).toThrow('baseUrl');
    }
    expect(() => new STT({ apiKey: API_KEY, mode: 'fast' }).stream()).toThrow('not streaming');
  });

  it('derives normalized Live and Fast URLs and uses the injected transport', async () => {
    const fake = new FakeScribe();
    await fake.start();
    const urls: string[] = [];
    const session = {
      wsConnect: async (
        url: string,
        protocols: string[],
        options: { headers: Record<string, string> },
      ) => {
        urls.push(url);
        expect(protocols).toEqual(['live-asr']);
        return new WebSocket(fake.urls().liveUrl!, protocols, { headers: options.headers });
      },
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        return fetch(fake.urls().fastUrl!, init);
      },
    };
    try {
      await runStream(
        new STT({ apiKey: API_KEY, httpSession: session }).stream({ connOptions: NO_RETRY }),
        [],
      );
      await new STT({ apiKey: API_KEY, mode: 'fast', httpSession: session }).recognize(frames(0.1));
      const baseUrl = 'http://localhost:8080/scribe///';
      await runStream(
        new STT({ apiKey: API_KEY, baseUrl, httpSession: session }).stream({
          connOptions: NO_RETRY,
        }),
        [],
      );
      await new STT({ apiKey: API_KEY, mode: 'fast', baseUrl, httpSession: session }).recognize(
        frames(0.1),
      );
      expect(urls).toEqual([
        'wss://api.zoom.us/v2/aiservices/scribe/live',
        'https://api.zoom.us/v2/aiservices/scribe/transcribe',
        'ws://localhost:8080/scribe/live',
        'http://localhost:8080/scribe/transcribe',
      ]);
    } finally {
      await fake.close();
    }
  });
});

describe('Scribe Live', () => {
  let fake: FakeScribe;
  beforeEach(async () => {
    fake = new FakeScribe();
    await fake.start();
  });
  afterEach(async () => fake.close());

  it('uses the documented handshake, headers, config, binary PCM, and graceful close', async () => {
    const zoom = makeSTT(fake);
    await runStream(zoom.stream({ connOptions: NO_RETRY }), frames(0.2));
    const session = fake.sessions[0]!;
    expect(session.protocol).toBe('live-asr');
    expect(session.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(session.headers['user-agent']).toMatch(/^livekit-plugins-zoom-ai\//);
    expect(session.headers['x-zm-trackingid']).toMatch(/^zoom_ai_community_livekit_/);
    expect(session.updates).toEqual([
      {
        type: 'session.update',
        language: 'en-US',
        audio: { format: 'pcm16' },
        turn_detection: { silence_duration_ms: 350 },
      },
    ]);
    expect(session.controls).toEqual([{ type: 'session.close' }]);
    expect(Buffer.concat(session.audio)).toHaveLength(6400);
  });

  it('resamples input to 16 kHz mono PCM16', async () => {
    await runStream(makeSTT(fake).stream({ connOptions: NO_RETRY }), frames(1, 48000));
    expect(Buffer.concat(fake.sessions[0]!.audio).length).toBeGreaterThanOrEqual(30000);
    expect(Buffer.concat(fake.sessions[0]!.audio).length).toBeLessThanOrEqual(32000);
  });

  it('emits start, final, end, and usage in order with timing and cleaned text', async () => {
    const capturedAt = Date.now();
    fake.onAudio = (session) => {
      const length = Buffer.concat(session.audio).length;
      if (length >= 3200 && !(session as any).started) {
        (session as any).started = true;
        session.ws.send(
          JSON.stringify({ type: 'input_audio_buffer.speech_started', audio_start_ms: 100 }),
        );
      }
      if (length >= 32000 && !(session as any).done) {
        (session as any).done = true;
        session.ws.send(
          JSON.stringify({
            type: 'transcription.completed',
            item_id: 'item_1',
            transcript: '[Speaker 1] Hello there.',
            audio_start_ms: 100,
            audio_end_ms: 900,
          }),
        );
      }
    };
    const events = await runStream(makeSTT(fake).stream({ connOptions: NO_RETRY }), frames(1.5));
    expect(events.slice(0, 4).map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
      stt.SpeechEventType.RECOGNITION_USAGE,
    ]);
    const final = events[1]!;
    const started = events[0]!;
    expect(final.requestId).toBe('item_1');
    expect(final.alternatives![0]).toMatchObject({
      text: 'Hello there.',
      language: 'en-US',
      startTime: 0.1,
      endTime: 0.9,
    });
    expect(events[2]!.speechEndTime).toBe(final.speechEndTime);
    // The frames were queued immediately while connecting. Scribe's session clock starts at
    // their estimated capture time, not when the socket opened.
    expect(started.speechStartTime).toBeGreaterThanOrEqual(capturedAt - 1600);
    expect(started.speechStartTime).toBeLessThanOrEqual(capturedAt - 1200);
    expect(final.speechEndTime! - started.speechStartTime!).toBeCloseTo(450, -2);
    const usage = events.reduce(
      (sum, event) => sum + (event.recognitionUsage?.audioDuration ?? 0),
      0,
    );
    expect(usage).toBeCloseTo(1.5);
  });

  it.each([
    [350, 550],
    [null, 900],
  ])('subtracts the configured silence window from speech end (%s)', async (silence, expected) => {
    fake.onAudio = (session) => {
      if ((session as any).done) return;
      (session as any).done = true;
      session.ws.send(
        JSON.stringify({
          type: 'transcription.completed',
          transcript: 'Hello.',
          audio_start_ms: 100,
          audio_end_ms: 900,
        }),
      );
    };
    const events = await runStream(
      makeSTT(fake, { silenceDurationMs: silence }).stream({ connOptions: NO_RETRY }),
      frames(0.1),
    );
    const start = events[0]!.speechStartTime!;
    const end = events.find(
      (event) => event.type === stt.SpeechEventType.END_OF_SPEECH,
    )!.speechEndTime!;
    expect(end - start).toBeCloseTo(expected - 100, -1);
  });

  it('deep-merges extraKwargs and protects type and PCM format', async () => {
    const extraKwargs = {
      config: { vocabulary_id: 'acct_vocab_1', diarization: false },
      turn_detection: { max_segment_duration_ms: 15000 },
      outputs: { future_output: { enabled: true } },
      audio: { format: 'opus' },
      type: 'wrong',
    };
    await runStream(
      makeSTT(fake, { diarization: true, extraKwargs }).stream({ connOptions: NO_RETRY }),
      [],
    );
    expect(fake.sessions[0]!.updates[0]).toEqual({
      type: 'session.update',
      language: 'en-US',
      audio: { format: 'pcm16' },
      config: { diarization: false, vocabulary_id: 'acct_vocab_1' },
      turn_detection: { silence_duration_ms: 350, max_segment_duration_ms: 15000 },
      outputs: { future_output: { enabled: true } },
    });
    expect(extraKwargs.audio).toEqual({ format: 'opus' });
  });

  it('acts on diarization and polishing enabled only through extraKwargs', async () => {
    fake.onAudio = (session) => {
      if ((session as any).done) return;
      (session as any).done = true;
      session.ws.send(
        JSON.stringify({
          type: 'transcription.completed',
          transcript: '[Speaker 1] Um, hello.',
          speaker: 'Speaker 1',
          outputs: { text_polishing: { text: '[Speaker 1] Hello.' } },
          audio_end_ms: 500,
        }),
      );
    };
    const events = await runStream(
      makeSTT(fake, {
        extraKwargs: {
          config: { diarization: true },
          outputs: { text_polishing: { enabled: true } },
        },
      }).stream({ connOptions: NO_RETRY }),
      frames(0.1),
    );
    const data = events.find((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!
      .alternatives![0];
    expect(data).toMatchObject({
      text: 'Hello.',
      speakerId: 'Speaker 1',
      metadata: { transcript: 'Um, hello.' },
    });
    expect(fake.sessions[0]!.updates[0]!.outputs.text_polishing.include_transcript).toBe(true);
  });

  it('requests recognition features only when configured', async () => {
    await runStream(
      makeSTT(fake, {
        model: 'zoom-scribe-multilingual',
        languageDetection: 'continuous',
        diarization: true,
        vocabulary: ['Zoom Scribe', 'LiveKit'],
        textPolishing: true,
        extraKwargs: { config: { profanity_filter: true } },
      }).stream({ connOptions: NO_RETRY }),
      [],
    );
    expect(fake.sessions[0]!.updates[0]).toMatchObject({
      config: {
        model: 'zoom-scribe-multilingual',
        language_detection: { mode: 'continuous' },
        diarization: true,
        vocabulary: { phrases: ['Zoom Scribe', 'LiveKit'] },
        profanity_filter: true,
      },
      outputs: { text_polishing: { enabled: true, include_transcript: true } },
    });
  });

  it.each([
    [500, { silence_duration_ms: 500 }],
    [null, undefined],
  ])('configures silenceDurationMs=%s', async (silenceDurationMs, expected) => {
    await runStream(makeSTT(fake, { silenceDurationMs }).stream({ connOptions: NO_RETRY }), []);
    expect(fake.sessions[0]!.updates[0]!.turn_detection).toEqual(expected);
  });

  it('uses detected language, polishing, and multi-speaker metadata', async () => {
    const spans = [
      { speaker: 'Speaker 1', transcript: 'Hi', audio_start_ms: 0, audio_end_ms: 500 },
      { speaker: 'Speaker 2', transcript: 'Hello', audio_start_ms: 500, audio_end_ms: 900 },
    ];
    fake.onAudio = (session) => {
      if ((session as any).done) return;
      (session as any).done = true;
      session.ws.send(
        JSON.stringify({
          type: 'transcription.completed',
          item_id: 'item',
          transcript: '[Speaker 1] Um hi. [Speaker 2] Hello.',
          language: 'es',
          speaker_segments: spans,
          outputs: { text_polishing: { text: '[Speaker 1] Hi. [Speaker 2] Hello.' } },
          audio_start_ms: 0,
          audio_end_ms: 900,
        }),
      );
    };
    const events = await runStream(
      makeSTT(fake, {
        languageDetection: 'continuous',
        diarization: true,
        textPolishing: true,
      }).stream({ connOptions: NO_RETRY }),
      frames(0.1),
    );
    const data = events.find((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!
      .alternatives![0];
    expect(data).toMatchObject({
      text: 'Hi. Hello.',
      language: 'es',
      speakerId: null,
      metadata: { transcript: 'Um hi. Hello.', speaker_segments: spans },
    });
  });

  it('falls back after failed polishing and closes an empty final turn', async () => {
    fake.onAudio = (session) => {
      if ((session as any).done) return;
      (session as any).done = true;
      session.ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      session.ws.send(
        JSON.stringify({
          type: 'transcription.completed',
          transcript: '',
          outputs: { text_polishing: { text: '[polishing_failed: timeout]' } },
          audio_end_ms: 500,
        }),
      );
    };
    const events = await runStream(
      makeSTT(fake, { textPolishing: true }).stream({ connOptions: NO_RETRY }),
      frames(0.1),
    );
    expect(events.filter((event) => !event.recognitionUsage).map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
  });

  it('uses a nonempty recognized transcript when polishing fails', async () => {
    fake.onAudio = (session) => {
      if ((session as any).done) return;
      (session as any).done = true;
      session.ws.send(
        JSON.stringify({
          type: 'transcription.completed',
          transcript: 'Um, hello there.',
          outputs: { text_polishing: { text: '[polishing_failed: timeout]' } },
          audio_end_ms: 500,
        }),
      );
    };
    const events = await runStream(
      makeSTT(fake, { textPolishing: true }).stream({ connOptions: NO_RETRY }),
      frames(0.1),
    );
    const data = events.find((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!
      .alternatives![0];
    expect(data.text).toBe('Um, hello there.');
    expect(data.metadata).toBeUndefined();
  });

  it('reports one diarized speaker directly and an empty language when detection reports none', async () => {
    fake.onAudio = (session) => {
      if ((session as any).done) return;
      (session as any).done = true;
      session.ws.send(
        JSON.stringify({
          type: 'transcription.completed',
          transcript: '[Speaker 1] Hello.',
          speaker: 'Speaker 1',
          audio_end_ms: 500,
        }),
      );
    };
    const events = await runStream(
      makeSTT(fake, { diarization: true, languageDetection: 'continuous' }).stream({
        connOptions: NO_RETRY,
      }),
      frames(0.1),
    );
    expect(events[1]!.alternatives![0]).toMatchObject({
      text: 'Hello.',
      language: '',
      speakerId: 'Speaker 1',
    });
  });

  it('does not expose speaker metadata when Live diarization is disabled', async () => {
    fake.onAudio = (session) => {
      if ((session as any).done) return;
      (session as any).done = true;
      session.ws.send(
        JSON.stringify({
          type: 'transcription.completed',
          transcript: '[Speaker 1] Hello.',
          speaker: 'Speaker 1',
          speaker_segments: [{ speaker: 'Speaker 1', transcript: 'Hello.' }],
          audio_end_ms: 500,
        }),
      );
    };
    const events = await runStream(makeSTT(fake).stream({ connOptions: NO_RETRY }), frames(0.1));
    const data = events.find((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!
      .alternatives![0];
    expect(data).toMatchObject({ text: 'Hello.', speakerId: null });
    expect(data.metadata).toBeUndefined();
    expect(fake.sessions[0]!.updates[0]).not.toHaveProperty('config');
  });

  it('warns when Scribe cannot diarize and keeps a non-fatal error session alive', async () => {
    const logger = log();
    const warning = vi.spyOn(logger, 'warn');
    const child = vi.spyOn(logger, 'child').mockReturnValue(logger);
    fake.onStart = (session) => {
      session.ws.send(JSON.stringify({ type: 'session.updated', diarization_enabled: false }));
      session.ws.send(
        JSON.stringify({
          type: 'error',
          error: { code: 'audio_gap', message: 'private audio detail', fatal: false },
        }),
      );
    };
    await runStream(
      makeSTT(fake, { diarization: true }).stream({ connOptions: NO_RETRY }),
      frames(0.1),
    );
    const rendered = warning.mock.calls.flat().map(String).join(' ');
    expect(rendered).toContain("can't label speakers");
    expect(rendered).toContain('audio_gap');
    expect(rendered).not.toContain('private audio detail');
    expect(fake.sessions).toHaveLength(1);
    child.mockRestore();
    warning.mockRestore();
  });

  it('reconnects on option updates and defers a mid-turn update until final', async () => {
    let releaseFinal = false;
    fake.onAudio = (session) => {
      if (fake.sessions.length !== 1) return;
      if (!(session as any).started) {
        (session as any).started = true;
        session.ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      }
      if (releaseFinal && !(session as any).done) {
        (session as any).done = true;
        session.ws.send(
          JSON.stringify({
            type: 'transcription.completed',
            transcript: 'Before the change.',
            audio_start_ms: 0,
            audio_end_ms: 400,
          }),
        );
      }
    };
    const zoom = makeSTT(fake);
    const stream = zoom.stream({ connOptions: NO_RETRY });
    for (const frame of frames(0.2)) stream.pushFrame(frame);
    await waitUntil(() => stream._speechStarted);
    zoom.updateOptions({ language: 'ja-JP', silenceDurationMs: 600 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.sessions).toHaveLength(1);
    releaseFinal = true;
    for (const frame of frames(0.1)) stream.pushFrame(frame);
    await waitUntil(() => fake.sessions.length === 2);
    const events = await runStream(stream, frames(0.1));
    expect(fake.sessions.map((session) => session.updates[0]!.language)).toEqual([
      'en-US',
      'ja-JP',
    ]);
    expect(fake.sessions[1]!.updates[0]!.turn_detection).toEqual({ silence_duration_ms: 600 });
    expect(fake.sessions[0]!.headers['x-zm-trackingid']).not.toBe(
      fake.sessions[1]!.headers['x-zm-trackingid'],
    );
    expect(
      events
        .filter((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)
        .map((event) => event.alternatives![0].text),
    ).toEqual(['Before the change.']);
    expect(fake.sessions[1]!.audio.length).toBeGreaterThan(0);
    expect(stream._sessionOffset).toBeGreaterThan(0);
  });

  it('supports stream language overrides, including an explicit empty language', async () => {
    await runStream(makeSTT(fake).stream({ language: 'de-DE', connOptions: NO_RETRY }), []);
    await runStream(makeSTT(fake).stream({ language: '', connOptions: NO_RETRY }), []);
    expect(fake.sessions.map((session) => session.updates[0]!.language)).toEqual(['de-DE', '']);
  });

  it('does not reconnect for an empty updateOptions call', async () => {
    const zoom = makeSTT(fake);
    const stream = zoom.stream({ language: 'de-DE', connOptions: NO_RETRY });
    await waitUntil(() => fake.sessions.length === 1);
    zoom.updateOptions();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runStream(stream, []);
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]!.updates[0]!.language).toBe('de-DE');
  });

  it('retries a server-ended session and closes an interrupted speech turn', async () => {
    fake.onStart = (session) => {
      if (fake.sessions.length !== 1) return;
      session.ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      session.ws.send(JSON.stringify({ type: 'session.closed', reason: 'server_shutdown' }));
      session.ws.close();
    };
    const zoom = makeSTT(fake);
    const events: stt.SpeechEvent[] = [];
    const stream = zoom.stream({ connOptions: FAST_RETRY });
    const collect = (async () => {
      for await (const event of stream) events.push(event);
    })();
    await waitUntil(() => fake.sessions.length === 2);
    stream.endInput();
    await collect;
    expect(events.filter((event) => !event.recognitionUsage).map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
  });

  it('reconnects after a dropped WebSocket', async () => {
    fake.onStart = (session) => {
      if (fake.sessions.length === 1) session.ws.terminate();
    };
    const stream = makeSTT(fake).stream({ connOptions: FAST_RETRY });
    await waitUntil(() => fake.sessions.length === 2);
    await runStream(stream, []);
    expect(fake.sessions).toHaveLength(2);
  });

  it('ignores malformed JSON and continues processing later messages', async () => {
    fake.onStart = (session) => {
      session.ws.send('{not json');
      session.ws.send(
        JSON.stringify({
          type: 'transcription.completed',
          transcript: 'Still alive.',
          audio_start_ms: 0,
          audio_end_ms: 100,
        }),
      );
    };
    const events = await runStream(makeSTT(fake).stream({ connOptions: NO_RETRY }), []);
    expect(
      events.find((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!.alternatives![0]
        .text,
    ).toBe('Still alive.');
  });

  it('retries a fatal error after session.updated', async () => {
    fake.onStart = (session) => {
      if (fake.sessions.length === 1) {
        session.ws.send(
          JSON.stringify({
            type: 'error',
            error: { code: 'internal_error', message: 'try again', fatal: true },
          }),
        );
        session.ws.close();
      }
    };
    const stream = makeSTT(fake).stream({ connOptions: FAST_RETRY });
    await waitUntil(() => fake.sessions.length === 2);
    await runStream(stream, []);
    expect(fake.sessions).toHaveLength(2);
  });

  it('keeps transcript timestamps continuous across an option reconnect and retry', async () => {
    fake.onStart = async (session) => {
      if (fake.sessions.indexOf(session) === 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        session.ws.send(JSON.stringify({ type: 'session.closed', reason: 'idle_timeout' }));
        session.ws.close();
      }
    };
    fake.onAudio = (session) => {
      if (fake.sessions.indexOf(session) !== 2 || (session as any).done) return;
      (session as any).done = true;
      session.ws.send(
        JSON.stringify({
          type: 'transcription.completed',
          transcript: 'Hello.',
          audio_start_ms: 0,
          audio_end_ms: 100,
        }),
      );
    };
    const zoom = makeSTT(fake);
    const stream = zoom.stream({ connOptions: FAST_RETRY });
    const startedAt = Date.now();
    for (const frame of frames(0.1)) stream.pushFrame(frame);
    await waitUntil(() => fake.sessions.length === 1 && fake.sessions[0]!.audio.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    zoom.updateOptions({ language: 'ja-JP' });
    await waitUntil(() => fake.sessions.length === 3);
    const eventsPromise = runStream(stream, frames(0.1));
    const events = await eventsPromise;
    const final = events.find((event) => event.type === stt.SpeechEventType.FINAL_TRANSCRIPT)!;
    const elapsed = (Date.now() - startedAt) / 1000;
    expect(final.alternatives![0].startTime).toBeGreaterThan(0.1);
    expect(final.alternatives![0].startTime).toBeLessThanOrEqual(elapsed);
  });

  it('sends silence once when input stops during an open turn', async () => {
    fake.onAudio = (session) => {
      if (!(session as any).started) {
        (session as any).started = true;
        session.ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
      }
    };
    const stream = makeSTT(fake).stream({ connOptions: NO_RETRY });
    for (const frame of frames(0.2)) stream.pushFrame(frame);
    const expected = 6400 + (16000 * 2 * (350 + 100)) / 1000;
    await waitUntil(() => Buffer.concat(fake.sessions[0]?.audio ?? []).length >= expected, 3000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(Buffer.concat(fake.sessions[0]!.audio)).toHaveLength(expected);
    stream.close();
  });

  it('sends 100 ms silence to keep an idle session alive', async () => {
    const stream = makeSTT(fake).stream({ connOptions: NO_RETRY });
    await waitUntil(() => fake.sessions.length === 1);
    await waitUntil(() => Buffer.concat(fake.sessions[0]!.audio).length >= 3200, 12000);
    const audio = Buffer.concat(fake.sessions[0]!.audio);
    expect(audio.length % 3200).toBe(0);
    expect(audio.every((byte) => byte === 0)).toBe(true);
    stream.close();
  }, 15000);

  it('does not retry settings rejected before session.updated and keeps API key private', async () => {
    const logger = log();
    const child = vi.spyOn(logger, 'child').mockReturnValue(logger);
    const warning = vi.spyOn(logger, 'warn');
    fake.rejectUpdate = [
      { code: 'invalid_config', message: 'no polishing', fatal: false },
      { code: 'missing_config', message: 'send config', fatal: true },
    ];
    const zoom = makeSTT(fake);
    const error = new Promise<Error>((resolve) =>
      zoom.once('error', ({ error }) => resolve(error)),
    );
    const stream = zoom.stream({ connOptions: FAST_RETRY });
    const collect = runStream(stream, []);
    const received = await error;
    await collect;
    expect(received).toBeInstanceOf(APIStatusError);
    expect(received.message).toBe('Zoom Scribe Live error missing_config: send config');
    expect((received as APIStatusError).retryable).toBe(false);
    expect((received as APIStatusError).requestId).toBe(
      fake.sessions[0]!.headers['x-zm-trackingid'],
    );
    expect(String(received)).not.toContain(API_KEY);
    expect(child).toHaveBeenCalledWith({ 'lk.pii.message': 'no polishing' });
    expect(warning.mock.calls.flat().map(String).join(' ')).not.toContain('no polishing');
    expect(fake.sessions).toHaveLength(1);
    child.mockRestore();
    warning.mockRestore();
  });

  it('reports handshake rejection as a non-retryable status error with tracking ID', async () => {
    fake.rejectHandshake = true;
    const zoom = makeSTT(fake);
    const error = new Promise<Error>((resolve) =>
      zoom.once('error', ({ error }) => resolve(error)),
    );
    await runStream(zoom.stream({ connOptions: NO_RETRY }), []);
    const received = (await error) as APIStatusError;
    expect(received).toBeInstanceOf(APIStatusError);
    expect(received.statusCode).toBe(401);
    expect(received.retryable).toBe(false);
    expect(received.requestId).toBe(fake.handshakeTrackingIds[0]);
    expect(String(received)).not.toContain(API_KEY);
  });

  it('closes cleanly while audio is flowing', async () => {
    const zoom = makeSTT(fake);
    const errors: Error[] = [];
    zoom.on('error', ({ error }) => errors.push(error));
    const stream = zoom.stream({ connOptions: NO_RETRY });
    for (const frame of frames(0.3)) stream.pushFrame(frame);
    await waitUntil(() => Buffer.concat(fake.sessions[0]?.audio ?? []).length > 0);
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual([]);
  });

  it('closes all streams when STT closes', async () => {
    const zoom = makeSTT(fake);
    const first = zoom.stream({ connOptions: NO_RETRY });
    const second = zoom.stream({ connOptions: NO_RETRY });
    await waitUntil(() => fake.sessions.length === 2);
    await zoom.close();
    expect(() => first.pushFrame(frames(0.02)[0]!)).toThrow();
    expect(() => second.pushFrame(frames(0.02)[0]!)).toThrow();
    expect(fake.sessions.every((session) => session.ws.readyState === WebSocket.CLOSED)).toBe(true);
  });

  it('warns for remote plaintext URLs but not loopback URLs', () => {
    const logger = log();
    const warning = vi.spyOn(logger, 'warn');
    new STT({ apiKey: API_KEY, baseUrl: 'http://scribe.example.com/x' });
    expect(
      warning.mock.calls
        .flat()
        .map(String)
        .filter((text) => text.includes('not encrypted')),
    ).toHaveLength(3);
    warning.mockClear();
    new STT({ apiKey: API_KEY, baseUrl: 'http://localhost:8080/x' });
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});

describe('Scribe Fast', () => {
  let fake: FakeScribe;
  beforeEach(async () => {
    fake = new FakeScribe();
    await fake.start();
  });
  afterEach(async () => fake.close());

  it('uploads multipart WAV, config, headers, and maps the response', async () => {
    const event = await makeSTT(fake, { mode: 'fast' }).recognize(frames(0.5));
    const request = fake.fastRequests[0]!;
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request.headers['user-agent']).toMatch(/^livekit-plugins-zoom-ai\//);
    expect(request.headers['x-zm-trackingid']).toMatch(/^zoom_ai_community_livekit_/);
    expect(request.fields).toEqual({ config: { language: 'en-US' } });
    expect(request.filename).toBe('utterance.wav');
    expect(request.contentType).toBe('audio/wav');
    expect(request.audio.subarray(0, 4).toString()).toBe('RIFF');
    expect(event).toMatchObject({ type: stt.SpeechEventType.FINAL_TRANSCRIPT, requestId: 'req_1' });
    expect(event.alternatives![0]).toMatchObject({
      language: 'en-US',
      text: 'Hi there! What is the capital of France?',
      startTime: 0.2,
      endTime: 2.7,
      speakerId: null,
    });
  });

  it('supports a per-call Fast language override', async () => {
    const event = await makeSTT(fake, { mode: 'fast' }).recognize(frames(0.1), {
      language: 'fr-FR',
      connOptions: NO_RETRY,
    });
    expect(fake.fastRequests[0]!.fields.config.language).toBe('fr-FR');
    expect(event.alternatives![0].language).toBe('fr-FR');
  });

  it('merges all recognition options and ignores extraKwargs.file', async () => {
    fake.fastBody = {
      request_id: 'req',
      result: { text_display: 'Um hello.', segments: [] },
      outputs: { text_polishing: { text: 'Hello.' } },
    };
    const event = await makeSTT(fake, {
      mode: 'fast',
      model: 'zoom-scribe-en-pro',
      languageDetection: 'once',
      diarization: true,
      wordTimeOffsets: true,
      channelSeparation: true,
      vocabulary: ['Zoom Scribe'],
      textPolishing: true,
      extraKwargs: {
        config: { profanity_filter: true },
        outputs: { future_output: { enabled: true } },
        reference_id: 'req-42',
        file: 'ignored',
      },
    }).recognize(frames(0.1));
    expect(fake.fastRequests[0]!.fields).toEqual({
      config: {
        language: 'en-US',
        model: 'zoom-scribe-en-pro',
        language_detection: { mode: 'once' },
        diarization: true,
        word_time_offsets: true,
        channel_separation: true,
        vocabulary: { phrases: ['Zoom Scribe'] },
        profanity_filter: true,
      },
      outputs: {
        text_polishing: { enabled: true },
        future_output: { enabled: true },
      },
      reference_id: 'req-42',
    });
    expect(event.alternatives![0]).toMatchObject({
      text: 'Hello.',
      metadata: { transcript: 'Um hello.' },
    });
    expect(event.alternatives![0].words).toBeUndefined();
  });

  it('omits disabled channel separation, word offsets, and diarization metadata', async () => {
    fake.fastBody = {
      request_id: 'req',
      result: {
        text_display: 'Hi.',
        segments: [
          {
            channel: 0,
            speaker: '',
            text: 'Hi.',
            start: 0,
            end: 1,
            words: [{ word: 'Hi.', start: 0, end: 1 }],
          },
        ],
      },
    };
    const data = (await makeSTT(fake, { mode: 'fast' }).recognize(frames(0.1))).alternatives![0];
    expect(fake.fastRequests[0]!.fields.config).not.toHaveProperty('channel_separation');
    expect(fake.fastRequests[0]!.fields.config).not.toHaveProperty('word_time_offsets');
    expect(data.words).toBeUndefined();
    expect(data.speakerId).toBeNull();
    expect(data.metadata).toBeUndefined();
  });

  it('surfaces diarization, channels, word timing, and detected language metadata', async () => {
    fake.fastBody = {
      request_id: 'req',
      result: {
        text_display: '[Speaker 1] Hi. [Speaker 2] Hello.',
        language: 'fr-FR',
        segments: [
          {
            channel: 0,
            speaker: 'Speaker 1',
            text: 'Hi.',
            start: 0.1,
            end: 0.3,
            words: [{ word: 'Hi.', start: 0.1, end: 0.3 }],
          },
          {
            channel: 1,
            speaker: 'Speaker 2',
            text: 'Hello.',
            start: 0.4,
            end: 0.9,
            words: [{ word: 'Hello.', start: 0.4, end: 0.9 }],
          },
        ],
      },
    };
    const data = (
      await makeSTT(fake, {
        mode: 'fast',
        diarization: true,
        channelSeparation: true,
        wordTimeOffsets: true,
        languageDetection: 'once',
      }).recognize(frames(0.1, 16000, 2))
    ).alternatives![0];
    expect(data).toMatchObject({
      text: 'Hi. Hello.',
      language: 'fr-FR',
      speakerId: null,
      metadata: {
        speaker_segments: [
          { speaker: 'Speaker 1', text: 'Hi.', start: 0.1, end: 0.3 },
          { speaker: 'Speaker 2', text: 'Hello.', start: 0.4, end: 0.9 },
        ],
        channel_segments: [
          { channel: 0, text: 'Hi.', start: 0.1, end: 0.3 },
          { channel: 1, text: 'Hello.', start: 0.4, end: 0.9 },
        ],
      },
    });
    expect(data.words?.map((word) => [word.text, word.startTime, word.endTime])).toEqual([
      ['Hi.', 0.1, 0.3],
      ['Hello.', 0.4, 0.9],
    ]);
    expect(fake.fastRequests[0]!.audio.readUInt16LE(22)).toBe(2);
  });

  it.each([
    [{ language: 'es-ES', segments: [] }, 'once', 'es-ES'],
    [{ segments: [{ text: 'Hola.' }] }, 'continuous', ''],
    [{ segments: [{ text: 'Hola.', language: 'es' }] }, 'continuous', 'es'],
    [{ segments: [{ text: 'Hola.' }] }, undefined, 'en-US'],
  ])('reports configured or detected language', async (result, languageDetection, expected) => {
    fake.fastBody = { request_id: 'req', result: { text_display: 'Hola.', ...result } };
    const data = (await makeSTT(fake, { mode: 'fast', languageDetection }).recognize(frames(0.1)))
      .alternatives![0];
    expect(data.language).toBe(expected);
  });

  it('raises status errors with Zoom reason and tracking ID', async () => {
    fake.fastStatus = 401;
    fake.fastBody = { code: 124, message: 'Invalid Access token' };
    const zoom = makeSTT(fake, { mode: 'fast' });
    const errorEvent = new Promise<Parameters<stt.STTCallbacks['error']>[0]>((resolve) =>
      zoom.once('error', resolve),
    );
    const error = await zoom.recognize(frames(0.1)).catch((value: unknown) => value);
    expect(error).toMatchObject({
      message: 'Zoom Scribe Fast error (HTTP 401): Invalid Access token',
      statusCode: 401,
      retryable: false,
    });
    expect((error as APIStatusError).requestId).toBe(
      fake.fastRequests[0]!.headers['x-zm-trackingid'],
    );
    expect(await errorEvent).toMatchObject({ error, recoverable: false, label: 'zoom.STT' });
    expect(fake.fastRequests[0]!.headers['x-zm-trackingid']).toMatch(/^zoom_ai_community_livekit_/);
  });

  it('raises a status error for a non-JSON success response', async () => {
    fake.fastRawBody = '<html>bad</html>';
    await expect(makeSTT(fake, { mode: 'fast' }).recognize(frames(0.1))).rejects.toThrow(
      'non-JSON',
    );
  });

  it('retries API connection errors with per-call connOptions and emits core metrics', async () => {
    let attempts = 0;
    const zoom = makeSTT(fake, {
      mode: 'fast',
      httpSession: {
        fetch: async (url, init) => {
          attempts += 1;
          if (attempts === 1) throw new TypeError('temporary connection failure');
          return fetch(url, init);
        },
      },
    });
    const metrics = vi.fn();
    zoom.on('metrics_collected', metrics);
    const event = await zoom.recognize(frames(0.1), {
      connOptions: FAST_RETRY,
    });
    expect(event.requestId).toBe('req_1');
    expect(attempts).toBe(2);
    expect(metrics).toHaveBeenCalledOnce();
    expect(metrics.mock.calls[0]![0]).toMatchObject({
      streamed: false,
      metadata: { modelProvider: 'Zoom', modelName: 'scribe-fast' },
    });
  });

  it('preserves caller cancellation for both recognize overloads', async () => {
    const reason = new Error('caller cancelled');
    const zoom = makeSTT(fake, {
      mode: 'fast',
      httpSession: {
        fetch: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
              once: true,
            });
          }),
      },
    });
    const first = new AbortController();
    const firstRequest = zoom.recognize(frames(0.1), first.signal);
    first.abort(reason);
    await expect(firstRequest).rejects.toBe(reason);

    const second = new AbortController();
    const secondRequest = zoom.recognize(frames(0.1), {
      abortSignal: second.signal,
      connOptions: FAST_RETRY,
    });
    second.abort(reason);
    await expect(secondRequest).rejects.toBe(reason);
  });

  it('maps response-body read failures to APIConnectionError', async () => {
    const zoom = makeSTT(fake, {
      mode: 'fast',
      httpSession: {
        fetch: async () =>
          ({
            ok: true,
            status: 200,
            text: async () => {
              throw new TypeError('body disconnected');
            },
          }) as Response,
      },
    });
    await expect(zoom.recognize(frames(0.1), { connOptions: NO_RETRY })).rejects.toBeInstanceOf(
      APIConnectionError,
    );
  });

  it('applies request timeout while reading the response body', async () => {
    const zoom = makeSTT(fake, {
      mode: 'fast',
      httpSession: {
        fetch: async (_url, init) =>
          ({
            ok: true,
            status: 200,
            text: async () =>
              new Promise<string>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
                  once: true,
                });
              }),
          }) as Response,
      },
    });
    await expect(
      zoom.recognize(frames(0.1), {
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 10 },
      }),
    ).rejects.toHaveProperty('name', 'APITimeoutError');
  });

  it('wraps a refused HTTP connection as APIConnectionError', async () => {
    const address = fake.server!.address() as AddressInfo;
    await fake.close();
    const zoom = new STT({
      apiKey: API_KEY,
      mode: 'fast',
      fastUrl: `http://127.0.0.1:${address.port}/transcribe`,
    });
    await expect(zoom.recognize(frames(0.1))).rejects.toBeInstanceOf(APIConnectionError);
    fake = new FakeScribe();
    await fake.start();
  });
});
