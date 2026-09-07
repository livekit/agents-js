// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TTS } from './tts.js';

const hasSpeechifyConfig = Boolean(process.env.SPEECHIFY_API_KEY && process.env.OPENAI_API_KEY);

if (hasSpeechifyConfig) {
  describe('Speechify', async () => {
    await testTts(new TTS(), new STT());
  });
} else {
  describe('Speechify', () => {
    it.skip('requires SPEECHIFY_API_KEY and OPENAI_API_KEY', () => {});
  });
}

// 0.2s of 24 kHz mono s16le silence per audio chunk.
const AUDIO_BYTES = Buffer.alloc(9600);

// Two word-level speech marks, times in absolute milliseconds.
const SPEECH_MARKS = [
  { type: 'word', value: 'hello', start: 0, end: 5, start_time: 0, end_time: 500 },
  { type: 'word', value: 'world', start: 6, end: 11, start_time: 500, end_time: 1000 },
];

interface CapturedRequest {
  url?: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

function writeSse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function startStreamServer(): Promise<{
  server: Server;
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Audio chunk, a marks-only chunk, then the terminal done event.
      writeSse(res, 'speech.chunk', { audio: AUDIO_BYTES.toString('base64') });
      writeSse(res, 'speech.chunk', { speech_marks: SPEECH_MARKS });
      writeSse(res, 'speech.done', { billable_characters_count: 11, audio_duration_ms: 200 });
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, requests };
}

async function collect(
  stream: tts.SynthesizeStream | tts.ChunkedStream,
): Promise<tts.SynthesizedAudio[]> {
  const events: tts.SynthesizedAudio[] = [];
  for await (const event of stream) {
    if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
  }
  return events;
}

describe('Speechify TTS (mocked /v1/audio/stream/with-timestamps SSE)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('streams a one-shot request with word timestamps', async () => {
    const started = await startStreamServer();
    server = started.server;

    const speechify = new TTS({ apiKey: 'test-key', baseUrl: started.baseUrl });
    const events = await collect(speechify.synthesize('hello world'));

    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)!.final).toBe(true);
    expect(events.filter((e) => e.final)).toHaveLength(1);

    const timed = events.flatMap((e) => e.timedTranscripts ?? []);
    expect(timed.map((t) => t.text)).toEqual(['hello ', 'world ']);
    expect(timed[0]!.startTime).toBeCloseTo(0);
    expect(timed[1]!.startTime).toBeCloseTo(0.5);

    expect(started.requests[0]!.url).toBe('/v1/audio/stream/with-timestamps');
    const body = started.requests[0]!.body;
    expect(body.input).toBe('hello world');
    expect(body.voice_id).toBe('dominic_32');
    expect(body.model).toBe('simba-3.2');
    expect(body.output_format).toBe('pcm_24000');

    await speechify.close();
  });

  it('streams sentence-by-sentence and ends with a single final frame', async () => {
    const started = await startStreamServer();
    server = started.server;

    const speechify = new TTS({ apiKey: 'test-key', baseUrl: started.baseUrl });
    const stream = speechify.stream();
    stream.pushText('Hello world. Goodbye world.');
    stream.endInput();

    const events = await collect(stream);
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)!.final).toBe(true);
    expect(events.filter((e) => e.final)).toHaveLength(1);
    expect(started.requests.length).toBeGreaterThanOrEqual(1);

    stream.close();
    await speechify.close();
  });

  it('ends each flushed segment with its own final frame and segment id', async () => {
    const started = await startStreamServer();
    server = started.server;

    const speechify = new TTS({ apiKey: 'test-key', baseUrl: started.baseUrl });
    const stream = speechify.stream();
    stream.pushText('Hello world.');
    stream.flush();
    stream.pushText('Goodbye world.');
    stream.endInput();

    const events = await collect(stream);
    const finals = events.filter((e) => e.final);
    // One final frame per flushed segment.
    expect(finals).toHaveLength(2);
    // Each segment carries a distinct segment id.
    expect(new Set(finals.map((e) => e.segmentId)).size).toBe(2);

    stream.close();
    await speechify.close();
  });

  it('reports metrics for each flushed segment (back-to-back)', async () => {
    const started = await startStreamServer();
    server = started.server;

    const speechify = new TTS({ apiKey: 'test-key', baseUrl: started.baseUrl });
    const metrics: Array<{ ttfbMs: number }> = [];
    speechify.on('metrics_collected', (m) => metrics.push(m));

    const stream = speechify.stream();
    stream.pushText('Hello world.');
    stream.flush();
    stream.pushText('Goodbye world.');
    stream.endInput();

    await collect(stream);

    // One metrics event per flushed segment — neither swallowed by a shared,
    // async-reset started-time anchor.
    expect(metrics).toHaveLength(2);
    // A non-negative ttfb proves the per-segment anchor was set.
    for (const m of metrics) {
      expect(m.ttfbMs).toBeGreaterThanOrEqual(0);
    }

    stream.close();
    await speechify.close();
  });

  it('sends Speechify-Caller attribution headers', async () => {
    const started = await startStreamServer();
    server = started.server;

    const speechify = new TTS({ apiKey: 'test-key', baseUrl: started.baseUrl });
    await collect(speechify.synthesize('attribute me'));

    const headers = started.requests[0]!.headers;
    expect(headers['speechify-caller']).toBe('livekit-typescript');
    expect(headers['speechify-caller-version']).toBeDefined();

    await speechify.close();
  });
});
