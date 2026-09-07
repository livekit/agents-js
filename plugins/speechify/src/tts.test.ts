// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import { type IncomingMessage, type Server, createServer } from 'node:http';
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

// 0.2s of 24 kHz mono s16le silence — one request's worth of raw PCM.
const AUDIO_BYTES = Buffer.alloc(9600);

// Two word-level speech marks, times in milliseconds (as Speechify sends them).
const SPEECH_MARKS = {
  type: 'sentence',
  start: 0,
  end: 11,
  start_time: 0,
  end_time: 1000,
  value: 'hello world',
  chunks: [
    { type: 'word', value: 'hello', start: 0, end: 5, start_time: 0, end_time: 500 },
    { type: 'word', value: 'world', start: 6, end: 11, start_time: 500, end_time: 1000 },
  ],
};

interface CapturedRequest {
  url?: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

async function startSpeechServer(): Promise<{
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
      requests.push({
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : {},
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          audio_data: AUDIO_BYTES.toString('base64'),
          audio_format: 'pcm',
          billable_characters_count: 11,
          speech_marks: SPEECH_MARKS,
        }),
      );
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

describe('Speechify TTS (mocked /v1/audio/speech)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('synthesizes a one-shot request with word timestamps', async () => {
    const started = await startSpeechServer();
    server = started.server;

    const speechify = new TTS({ apiKey: 'test-key', baseUrl: started.baseUrl });
    const events = await collect(speechify.synthesize('hello world'));

    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)!.final).toBe(true);

    const timed = events.flatMap((e) => e.timedTranscripts ?? []);
    expect(timed.map((t) => t.text)).toEqual(['hello', 'world']);
    // Speechify ms → TimedString seconds.
    expect(timed[0]!.startTime).toBeCloseTo(0);
    expect(timed[1]!.startTime).toBeCloseTo(0.5);

    expect(started.requests[0]!.url).toBe('/v1/audio/speech');
    const body = started.requests[0]!.body;
    expect(body.input).toBe('hello world');
    expect(body.voice_id).toBe('dominic_32');
    expect(body.model).toBe('simba-3.2');
    expect(body.output_format).toBe('pcm_24000');

    await speechify.close();
  });

  it('streams sentence-by-sentence and ends with a final frame', async () => {
    const started = await startSpeechServer();
    server = started.server;

    const speechify = new TTS({ apiKey: 'test-key', baseUrl: started.baseUrl });
    const stream = speechify.stream();
    stream.pushText('Hello world. Goodbye world.');
    stream.endInput();

    const events = await collect(stream);
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)!.final).toBe(true);
    // Exactly one `final: true` across the whole stream.
    expect(events.filter((e) => e.final)).toHaveLength(1);
    // At least one synthesis request was issued for the streamed text.
    expect(started.requests.length).toBeGreaterThanOrEqual(1);

    stream.close();
    await speechify.close();
  });

  it('sends Speechify-Caller attribution headers', async () => {
    const started = await startSpeechServer();
    server = started.server;

    const speechify = new TTS({ apiKey: 'test-key', baseUrl: started.baseUrl });
    await collect(speechify.synthesize('attribute me'));

    const headers = started.requests[0]!.headers;
    expect(headers['speechify-caller']).toBe('livekit-typescript');
    expect(headers['speechify-caller-version']).toBeDefined();

    await speechify.close();
  });
});
