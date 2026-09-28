// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  type APIError,
  APIStatusError,
  APITimeoutError,
  log,
  tts,
} from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const SAMPLES_PER_WORD = 2400;
const FIRST_CHUNK_BYTES = 1216;
const FIRST = 'Thanks for calling, how can I help you today?';
const SECOND = 'Your order shipped yesterday and arrives Friday.';
const FAST_RETRY: APIConnectOptions = { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 5000 };

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type Handler = (req: Received, res: ServerResponse) => void;

interface FakeSpeechify {
  baseUrl: string;
  requests: Received[];
  connections: number;
  closedConnections: number;
  close(): Promise<void>;
}

const servers: FakeSpeechify[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(handler: Handler): Promise<FakeSpeechify> {
  const requests: Received[] = [];
  let connections = 0;
  let closedConnections = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const received: Received = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : {},
      };
      requests.push(received);
      if (received.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      handler(received, res);
    });
  });
  server.on('connection', (socket: Socket) => {
    connections++;
    socket.on('close', () => closedConnections++);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const fake: FakeSpeechify = {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get connections() {
      return connections;
    },
    get closedConnections() {
      return closedConnections;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(fake);
  return fake;
}

const words = (text: string) =>
  [...text.matchAll(/\S+/g)].map((match) => ({
    value: match[0],
    start: match.index!,
    end: match.index! + match[0].length,
  }));

const pcm = (samples: number, fill: number) => {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(fill, i * 2);
  return buffer;
};

const send = (res: ServerResponse, event: Record<string, unknown>) =>
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

const sendAudio = (res: ServerResponse, audio: Buffer) =>
  send(res, { type: 'speech.chunk', audio: audio.toString('base64') });

const beginStream = (res: ServerResponse) =>
  res.writeHead(200, { 'content-type': 'text/event-stream', 'speechify-request-id': 'req_1' });

interface SpeakOptions {
  fill?: number;
  /** Which words get a speech mark; the service marks every spoken word. */
  marked?: (word: string) => boolean;
  /** Shifts the character offsets, as when they address text other than the input. */
  shift?: number;
}

/** Answers like the service: a small first audio chunk, the rest with the marks, then done. */
function speak(res: ServerResponse, text: string, options: SpeakOptions = {}) {
  const { fill = 1, marked = () => true, shift = 0 } = options;
  const spoken = words(text);
  const audio = pcm(spoken.length * SAMPLES_PER_WORD, fill);
  const marks = spoken
    .map((word, i) => ({
      type: 'word',
      value: word.value,
      start: word.start + shift,
      end: word.end + shift,
      start_time: i * 100,
      end_time: (i + 1) * 100,
    }))
    .filter((mark) => marked(mark.value));
  beginStream(res);
  sendAudio(res, audio.subarray(0, FIRST_CHUNK_BYTES));
  sendAudio(res, audio.subarray(FIRST_CHUNK_BYTES));
  send(res, { type: 'speech.chunk', speech_marks: marks });
  send(res, {
    type: 'speech.done',
    billable_characters_count: text.length,
    audio_duration_ms: spoken.length * 100,
  });
  res.end();
}

const input = (req: Received) => req.body.input as string;

const speakAll: Handler = (req, res) => speak(res, input(req));

async function drain(stream: tts.SynthesizeStream | tts.ChunkedStream) {
  const events: tts.SynthesizedAudio[] = [];
  let ended = false;
  for await (const event of stream) {
    if (event === tts.SynthesizeStream.END_OF_STREAM) {
      ended = true;
      break;
    }
    events.push(event);
  }
  return { events, ended };
}

/** The frames' samples as runs of [value, count], to see what was spoken and how often. */
const runs = (events: tts.SynthesizedAudio[]) => {
  const out: [number, number][] = [];
  for (const { frame } of events) {
    for (const sample of frame.data) {
      const last = out.at(-1);
      if (last && last[0] === sample) last[1]++;
      else out.push([sample, 1]);
    }
  }
  return out;
};

const timedText = (events: tts.SynthesizedAudio[]) =>
  events.flatMap((event) => event.timedTranscripts ?? []);

const joined = (events: tts.SynthesizedAudio[]) =>
  timedText(events)
    .map((timed) => timed.text)
    .join('');

const newTTS = (baseUrl: string) => {
  const speechify = new TTS({ apiKey: 'test-key', baseUrl });
  const errors: { error: Error; recoverable: boolean }[] = [];
  speechify.on('error', ({ error, recoverable }) => errors.push({ error, recoverable }));
  return { speechify, errors };
};

describe('synthesize', () => {
  it('streams one request and forwards audio and word timestamps as they arrive', async () => {
    const server = await startServer(speakAll);
    const { speechify } = newTTS(server.baseUrl);

    const { events } = await drain(speechify.synthesize(FIRST));

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request!.method).toBe('POST');
    expect(request!.url).toBe('/v1/audio/stream/with-timestamps');
    expect(request!.headers.authorization).toBe('Bearer test-key');
    expect(request!.headers['speechify-caller']).toBe('livekit');
    expect(request!.headers['speechify-caller-version']).toMatch(/\S/);
    expect(request!.body).toEqual({
      input: FIRST,
      voice_id: 'dominic_32',
      model: 'simba-3.2',
      output_format: 'pcm_24000',
    });

    expect(runs(events)).toEqual([[1, words(FIRST).length * SAMPLES_PER_WORD]]);
    expect(events.every((event) => event.frame.samplesPerChannel <= 240)).toBe(true);
    expect(events.map((event) => event.final)).toEqual([
      ...Array(events.length - 1).fill(false),
      true,
    ]);
    expect(joined(events)).toBe(FIRST);
    expect(timedText(events)[1]).toMatchObject({ text: ' for', startTime: 0.1, endTime: 0.2 });
  });

  it('sends the language and normalization options when they are set', async () => {
    const server = await startServer(speakAll);
    const speechify = new TTS({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      voiceId: 'lisa',
      model: 'simba-3.0',
      language: 'de-DE',
      loudnessNormalization: true,
      textNormalization: false,
    });

    await drain(speechify.synthesize('Guten Tag.'));

    expect(server.requests[0]!.body).toEqual({
      input: 'Guten Tag.',
      voice_id: 'lisa',
      model: 'simba-3.0',
      language: 'de-DE',
      output_format: 'pcm_24000',
      options: { loudness_normalization: true, text_normalization: false },
    });
  });

  it('keeps the spacing and punctuation of the input in the word timestamps', async () => {
    const text = 'Hi,  "friend" -- ok !';
    const server = await startServer((req, res) =>
      speak(res, input(req), { marked: (word) => word !== '!' }),
    );
    const { speechify } = newTTS(server.baseUrl);

    const { events } = await drain(speechify.synthesize(text));

    expect(timedText(events).map((timed) => timed.text)).toEqual([
      'Hi,',
      '  "friend"',
      ' --',
      ' ok',
      ' !',
    ]);
  });

  it('spaces the words when the marks do not address the input, with a warning', async () => {
    const server = await startServer((req, res) => speak(res, input(req), { shift: 3 }));
    const { speechify } = newTTS(server.baseUrl);
    const warn = vi.spyOn(log(), 'warn');

    const { events } = await drain(speechify.synthesize('one two three'));

    expect(joined(events)).toBe('one two three');
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('spaces the words of SSML input, whose marks address the text inside the markup', async () => {
    const server = await startServer((_req, res) => speak(res, 'one two three'));
    const { speechify } = newTTS(server.baseUrl);

    const warn = vi.spyOn(log(), 'warn');

    const { events } = await drain(speechify.synthesize('<speak>one two three</speak>'));

    expect(joined(events)).toBe('one two three');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('stream', () => {
  it('synthesizes each sentence as one request and offsets its word timestamps', async () => {
    const server = await startServer(speakAll);
    const { speechify } = newTTS(server.baseUrl);
    const stream = speechify.stream();

    stream.pushText(`${FIRST} ${SECOND}`);
    stream.endInput();
    const { events, ended } = await drain(stream);

    expect(ended).toBe(true);
    expect(server.requests.map(input)).toEqual([FIRST, SECOND]);
    expect(joined(events)).toBe(`${FIRST} ${SECOND}`);
    const firstSeconds = (words(FIRST).length * SAMPLES_PER_WORD) / 24000;
    const secondStart = timedText(events).find((timed) => timed.text === ' Your');
    expect(secondStart?.startTime).toBeCloseTo(firstSeconds);
    expect(events.filter((event) => event.final)).toHaveLength(1);
    expect(events.at(-1)!.final).toBe(true);
  });

  it('reads every response to the end so all requests share one connection', async () => {
    const server = await startServer(speakAll);
    const { speechify } = newTTS(server.baseUrl);

    const stream = speechify.stream();
    stream.pushText(`${FIRST} ${SECOND}`);
    stream.endInput();
    await drain(stream);
    await drain(speechify.synthesize(FIRST));

    expect(server.requests).toHaveLength(3);
    expect(server.connections).toBe(1);
  });

  it('ends a segment at each flush without waiting for more input', async () => {
    const server = await startServer(speakAll);
    const { speechify } = newTTS(server.baseUrl);
    const stream = speechify.stream();
    const iterator = stream[Symbol.asyncIterator]();

    stream.pushText(FIRST);
    stream.flush();
    const firstSegment: tts.SynthesizedAudio[] = [];
    while (!firstSegment.at(-1)?.final) {
      const { value } = await iterator.next();
      if (value === tts.SynthesizeStream.END_OF_STREAM) throw new Error('stream ended early');
      firstSegment.push(value);
    }

    stream.pushText(SECOND);
    stream.endInput();
    const { events: secondSegment, ended } = await drain(stream);

    expect(ended).toBe(true);
    expect(new Set(firstSegment.map((event) => event.segmentId)).size).toBe(1);
    expect(new Set(secondSegment.map((event) => event.segmentId)).size).toBe(1);
    expect(secondSegment[0]!.segmentId).not.toBe(firstSegment[0]!.segmentId);
    expect(secondSegment.at(-1)!.final).toBe(true);
    expect(joined([...firstSegment, ...secondSegment])).toBe(`${FIRST} ${SECOND}`);
  });

  it('retries a sentence that failed before its audio, after the input was consumed', async () => {
    let failed = false;
    const server = await startServer((req, res) => {
      if (input(req) === SECOND && !failed) {
        failed = true;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'service_unavailable', message: SECOND } }));
        return;
      }
      speak(res, input(req), { fill: input(req) === FIRST ? 1 : 2 });
    });
    const { speechify, errors } = newTTS(server.baseUrl);
    const stream = speechify.stream({ connOptions: FAST_RETRY });

    stream.pushText(`${FIRST} ${SECOND}`);
    stream.endInput();
    const { events, ended } = await drain(stream);

    expect(ended).toBe(true);
    expect(errors).toEqual([]);
    expect(server.requests.map(input)).toEqual([FIRST, SECOND, SECOND]);
    expect(runs(events)).toEqual([
      [1, words(FIRST).length * SAMPLES_PER_WORD],
      [2, words(SECOND).length * SAMPLES_PER_WORD],
    ]);
    expect(joined(events)).toBe(`${FIRST} ${SECOND}`);
  });

  it('does not retry a sentence once its audio was received', async () => {
    const server = await startServer((req, res) => {
      if (input(req) === SECOND) {
        beginStream(res);
        sendAudio(res, pcm(SAMPLES_PER_WORD, 2));
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      speak(res, input(req));
    });
    const { speechify, errors } = newTTS(server.baseUrl);
    const stream = speechify.stream({ connOptions: FAST_RETRY });

    stream.pushText(`${FIRST} ${SECOND}`);
    stream.endInput();
    const { events, ended } = await drain(stream);

    expect(ended).toBe(false);
    expect(server.requests.map(input)).toEqual([FIRST, SECOND]);
    expect(runs(events)).toEqual([
      [1, words(FIRST).length * SAMPLES_PER_WORD],
      [2, SAMPLES_PER_WORD],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(false);
    expect(errors[0]!.error).toBeInstanceOf(APIConnectionError);
    expect((errors[0]!.error as APIError).retryable).toBe(false);
  });

  it('closing the stream aborts the request in flight', async () => {
    const server = await startServer((_req, res) => {
      beginStream(res);
      sendAudio(res, pcm(SAMPLES_PER_WORD, 1));
    });
    const { speechify, errors } = newTTS(server.baseUrl);
    const stream = speechify.stream();

    stream.pushText(FIRST);
    stream.flush();
    await stream[Symbol.asyncIterator]().next();
    stream.close();

    await vi.waitFor(() => expect(server.closedConnections).toBe(1));
    expect(errors).toEqual([]);
  });
});

describe('errors', () => {
  it('raises an HTTP error with its status and code, never the input', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'speechify-request-id': 'req_9' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: `bad key for ${FIRST}` } }));
    });
    const { speechify, errors } = newTTS(server.baseUrl);

    await drain(speechify.synthesize(FIRST, FAST_RETRY));

    expect(server.requests).toHaveLength(1);
    const error = errors[0]!.error as APIStatusError;
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error.statusCode).toBe(401);
    expect(error.requestId).toBe('req_9');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('Speechify request failed with status 401 (unauthorized)');
    expect(String(error)).not.toContain(FIRST);
  });

  it('raises a mid-stream speech.error without the input', async () => {
    const server = await startServer((_req, res) => {
      beginStream(res);
      send(res, {
        type: 'speech.error',
        error: { code: 'content_policy_violation', message: FIRST },
        request_id: 'req_7',
      });
      res.end();
    });
    const { speechify, errors } = newTTS(server.baseUrl);
    const stream = speechify.stream({ connOptions: FAST_RETRY });

    stream.pushText(FIRST);
    stream.endInput();
    await drain(stream);

    expect(server.requests).toHaveLength(1);
    const error = errors[0]!.error as APIStatusError;
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error.requestId).toBe('req_7');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('Speechify synthesis failed (content_policy_violation)');
    expect(String(error)).not.toContain(FIRST);
  });

  it('treats a response that ends before speech.done as a failure', async () => {
    let calls = 0;
    const server = await startServer((req, res) => {
      if (calls++ === 0) {
        beginStream(res);
        res.end();
        return;
      }
      speak(res, input(req));
    });
    const { speechify, errors } = newTTS(server.baseUrl);

    const { events } = await drain(speechify.synthesize(FIRST, FAST_RETRY));

    expect(server.requests).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(runs(events)).toEqual([[1, words(FIRST).length * SAMPLES_PER_WORD]]);
  });

  it('times out a stalled request as a retryable APITimeoutError', async () => {
    const server = await startServer((req, res) => {
      if (server.requests.length > 1) speak(res, input(req));
    });
    const { speechify, errors } = newTTS(server.baseUrl);
    const stream = speechify.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 200 },
    });

    stream.pushText(FIRST);
    stream.endInput();
    const { ended } = await drain(stream);

    expect(ended).toBe(true);
    expect(errors).toEqual([]);
    expect(server.requests).toHaveLength(2);
  });

  it('reports the timeout once retries run out', async () => {
    const server = await startServer(() => {});
    const { speechify, errors } = newTTS(server.baseUrl);

    await drain(speechify.synthesize(FIRST, { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 200 }));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(APITimeoutError);
    expect(errors[0]!.error.message).toBe('Speechify request timed out');
  });

  it('maps a refused connection to a retryable APIConnectionError', async () => {
    const server = await startServer(speakAll);
    await server.close();
    const { speechify, errors } = newTTS(server.baseUrl);

    await drain(speechify.synthesize(FIRST, { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 }));

    expect(errors).toHaveLength(1);
    const error = errors[0]!.error;
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error.message).toBe('Speechify connection failed (ECONNREFUSED)');
  });
});

describe('connections', () => {
  it('prewarm opens the connection the first request uses, without the API key', async () => {
    const server = await startServer(speakAll);
    const { speechify } = newTTS(server.baseUrl);

    speechify.prewarm();
    speechify.prewarm();
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    await sleep(20);
    await drain(speechify.synthesize(FIRST));

    expect(server.requests.map((req) => req.url)).toEqual([
      '/health',
      '/v1/audio/stream/with-timestamps',
    ]);
    const [health] = server.requests;
    expect(health!.method).toBe('GET');
    expect(health!.headers.authorization).toBeUndefined();
    expect(health!.headers['speechify-caller']).toBe('livekit');
    expect(server.connections).toBe(1);
  });

  it('releaseIdleConnections closes idle connections and later requests reconnect', async () => {
    const server = await startServer(speakAll);
    const { speechify } = newTTS(server.baseUrl);

    await drain(speechify.synthesize(FIRST));
    await speechify.releaseIdleConnections();
    await vi.waitFor(() => expect(server.closedConnections).toBe(1));
    await drain(speechify.synthesize(SECOND));

    expect(server.connections).toBe(2);
  });
});
