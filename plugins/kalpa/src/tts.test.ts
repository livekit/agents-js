// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIStatusError,
  APITimeoutError,
  initializeLogger,
} from '@livekit/agents';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CANCEL_ACK_TIMEOUT, TTS } from './tts.js';

const CHUNK = Buffer.alloc(480 * 2, 1); // 20 ms at 24 kHz
const NO_RETRY: APIConnectOptions = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 2_000 };

interface ErrorEvent {
  type: 'error';
  fatal: boolean;
  error: { type: string; message: string };
}

class FakeKalpa {
  chunks: number;
  delay: number;
  ackCancel: boolean;
  error?: ErrorEvent | { error: ErrorEvent['error'] };
  maxChars?: number;
  connections = 0;
  received: Record<string, unknown>[] = [];
  flushed: string[] = [];

  constructor(
    options: {
      chunks?: number;
      delay?: number;
      ackCancel?: boolean;
      error?: ErrorEvent | { error: ErrorEvent['error'] };
      maxChars?: number;
    } = {},
  ) {
    this.chunks = options.chunks ?? 3;
    this.delay = options.delay ?? 0;
    this.ackCancel = options.ackCancel ?? true;
    this.error = options.error;
    this.maxChars = options.maxChars;
  }

  connect(ws: WebSocket): void {
    this.connections++;
    let text = '';
    let generation: ReturnType<typeof setTimeout> | undefined;
    let initialized = false;

    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      this.received.push(event);
      if (!initialized) {
        initialized = true;
        if (this.error && 'fatal' in this.error && this.error.fatal) {
          ws.send(JSON.stringify(this.error));
          ws.close(4401);
          return;
        }
        ws.send(JSON.stringify({ type: 'sessionCreated', session_id: 's', sample_rate: 24000 }));
        return;
      }
      if (event.type === 'sendText') {
        const next = text + (typeof event.text === 'string' ? event.text : '');
        if (this.maxChars !== undefined && next.length > this.maxChars) {
          ws.send(
            JSON.stringify({
              type: 'error',
              fatal: false,
              error: { type: 'invalid_request', message: 'Too long.' },
            }),
          );
          return;
        }
        text = next;
        if (event.flush) {
          this.flushed.push(text);
          const silent = !text.trim();
          generation = setTimeout(() => this.respond(ws, silent), this.delay);
          text = '';
        }
      } else if (event.type === 'cancelResponse') {
        text = '';
        if (generation) {
          clearTimeout(generation);
          ws.send(JSON.stringify({ type: 'responseDone', response_id: 'r', status: 'cancelled' }));
        }
        if (this.ackCancel) ws.send(JSON.stringify({ type: 'cancelled' }));
      }
    });
    ws.on('close', () => {
      if (generation) clearTimeout(generation);
    });
  }

  respond(ws: WebSocket, silent: boolean): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'responseCreated', response_id: 'r', sample_rate: 24000 }));
    if (this.error && 'fatal' in this.error) {
      const error = this.error;
      this.error = undefined;
      ws.send(JSON.stringify({ ...error, response_id: 'r' }));
      ws.send(JSON.stringify({ type: 'responseDone', response_id: 'r', status: 'cancelled' }));
      return;
    }
    let sent = 0;
    const sendChunk = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (sent >= (silent ? 0 : this.chunks)) {
        ws.send(JSON.stringify({ type: 'responseDone', response_id: 'r', status: 'completed' }));
        return;
      }
      sent++;
      ws.send(
        JSON.stringify({
          type: 'responseAudio',
          response_id: 'r',
          pcm_b64: CHUNK.toString('base64'),
        }),
      );
      setTimeout(sendChunk, 20);
    };
    sendChunk();
  }

  async post(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    this.received.push(JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>);
    if (this.error && 'error' in this.error && !('fatal' in this.error)) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(this.error));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'audio/pcm' });
    for (let i = 0; i < this.chunks; i++) response.write(CHUNK);
    response.end();
  }
}

async function serve<T>(fake: FakeKalpa, run: (tts: TTS) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    void fake.post(request, response);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (ws) => fake.connect(ws));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const instance = new TTS({ apiKey: 'key', baseURL: `http://127.0.0.1:${port}` });
  try {
    return await run(instance);
  } finally {
    await instance.close();
    sockets.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function speak(tts: TTS, text: string, connOptions = NO_RETRY): Promise<number> {
  const stream = tts.stream({ connOptions });
  if (text) stream.pushText(text);
  stream.endInput();
  let count = 0;
  for await (const event of stream) if (typeof event !== 'symbol') count++;
  if (stream.error) throw stream.error;
  return count;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => initializeLogger({ pretty: false, level: 'silent' }));

describe('Kalpa TTS', () => {
  it('shares one socket across replies', async () => {
    const fake = new FakeKalpa();
    await serve(fake, async (tts) => {
      expect(await speak(tts, 'Hello there.')).toBeGreaterThan(0);
      expect(await speak(tts, '')).toBe(0);
      expect(await speak(tts, 'Hello again.')).toBeGreaterThan(0);
    });
    expect(fake.connections).toBe(1);
    expect(fake.flushed).toEqual(['Hello there.', '', 'Hello again.']);
    expect(fake.received[0]).toMatchObject({ generation_config: {}, sample_rate: 24000 });
  });

  it.each([true, false])(
    'reuses the socket after a cancel acknowledgement: %s',
    async (ackCancel) => {
      const fake = new FakeKalpa({ chunks: 100, ackCancel });
      await serve(fake, async (tts) => {
        const stream = tts.stream({ connOptions: NO_RETRY });
        stream.pushText('A long reply that the user interrupts.');
        stream.endInput();
        await stream.next();
        stream.close();
        await sleep(CANCEL_ACK_TIMEOUT + 200);
        fake.chunks = 3;
        expect(await speak(tts, 'The next reply.')).toBeGreaterThan(0);
      });
      expect(fake.received).toContainEqual({ type: 'cancelResponse' });
      expect(fake.connections).toBe(ackCancel ? 1 : 2);
    },
  );

  it('ignores a flush before text', async () => {
    const fake = new FakeKalpa();
    await serve(fake, async (tts) => {
      const stream = tts.stream({ connOptions: NO_RETRY });
      stream.flush();
      stream.pushText('Hello there.');
      stream.endInput();
      let count = 0;
      for await (const event of stream) if (typeof event !== 'symbol') count++;
      expect(count).toBeGreaterThan(0);
    });
    expect(fake.flushed).toEqual(['Hello there.']);
  });

  it('discards buffered text when interrupted before flush', async () => {
    const fake = new FakeKalpa();
    await serve(fake, async (tts) => {
      const stream = tts.stream({ connOptions: NO_RETRY });
      stream.pushText('Half a sentence that');
      await sleep(100);
      stream.close();
      await sleep(200);
      expect(await speak(tts, 'The next reply.')).toBeGreaterThan(0);
    });
    expect(fake.received).toContainEqual({ type: 'sendText', text: 'Half a sentence that' });
    expect(fake.flushed).toEqual(['The next reply.']);
    expect(fake.connections).toBe(1);
  });

  it('counts the timeout from the flush', async () => {
    const fake = new FakeKalpa({ delay: 500 });
    await serve(fake, async (tts) => {
      const options = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1_000 };
      const stream = tts.stream({ connOptions: options });
      stream.pushText('A reply from a slow LLM.');
      await sleep(800);
      stream.endInput();
      let count = 0;
      for await (const event of stream) if (typeof event !== 'symbol') count++;
      expect(count).toBeGreaterThan(0);

      fake.delay = 3_000;
      await expect(speak(tts, 'Hello there.', options)).rejects.toBeInstanceOf(APITimeoutError);
    });
  });

  it.each([
    [{ type: 'authentication_error', message: 'Invalid key.' }, 401, false],
    [{ type: 'overloaded', message: 'Busy.' }, 503, true],
  ] as const)('maps errors to API status: %s', async (error, status, retryable) => {
    const fake = new FakeKalpa({ error: { type: 'error', fatal: status === 401, error } });
    let thrown: unknown;
    await serve(fake, async (tts) => {
      try {
        await speak(tts, 'Hello there.');
      } catch (value) {
        thrown = value;
      }
    });
    expect(thrown).toBeInstanceOf(APIStatusError);
    expect(thrown).toMatchObject({ statusCode: status, retryable });
  });

  it('retries a failed response on the same socket', async () => {
    const fake = new FakeKalpa({
      error: {
        type: 'error',
        fatal: false,
        error: { type: 'overloaded', message: 'Busy.' },
      },
    });
    await serve(fake, async (tts) => {
      expect(
        await speak(tts, 'Hello there.', { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 2_000 }),
      ).toBeGreaterThan(0);
    });
    expect(fake.flushed).toEqual(['Hello there.', 'Hello there.']);
    expect(fake.connections).toBe(1);
  });

  it('cancels refused text and keeps the socket', async () => {
    const fake = new FakeKalpa({ maxChars: 20 });
    let thrown: unknown;
    await serve(fake, async (tts) => {
      try {
        await speak(tts, 'A reply longer than the API accepts.');
      } catch (value) {
        thrown = value;
      }
      await sleep(200);
      expect(await speak(tts, 'Hello there.')).toBeGreaterThan(0);
    });
    expect(thrown).toMatchObject({ statusCode: 400, retryable: false });
    expect(fake.received).toContainEqual({ type: 'cancelResponse' });
    expect(fake.flushed.at(-1)).toBe('Hello there.');
    expect(fake.connections).toBe(1);
  });

  it('streams PCM over HTTP synthesis', async () => {
    const fake = new FakeKalpa({ chunks: 50 });
    let thrown: unknown;
    await serve(fake, async (tts) => {
      const frame = await tts.synthesize('Hello there.', NO_RETRY).collect();
      expect(frame.samplesPerChannel / frame.sampleRate).toBeCloseTo(1, 2);
      fake.error = { error: { type: 'overloaded', message: 'Busy.' } };
      const stream = tts.synthesize('Hello there.', NO_RETRY);
      for await (const _event of stream) {
        // API errors are exposed on the stream after iteration ends.
      }
      thrown = stream.error;
    });
    expect(fake.received[0]).toEqual({
      text: 'Hello there.',
      model: 'kalpa-tts-1',
      sample_rate: 24000,
    });
    expect(thrown).toMatchObject({ statusCode: 503 });
  });
});
