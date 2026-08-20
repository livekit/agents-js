// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
} from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTTS } from '@livekit/agents-plugins-test';
import type { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket as ServerWebSocket, WebSocketServer } from 'ws';
import { ChunkedStream, SynthesizeStream, TTS } from './tts.js';

initializeLogger({ pretty: false, level: 'silent' });

const TEST_OPTIONS: APIConnectOptions = {
  ...DEFAULT_API_CONNECT_OPTIONS,
  maxRetry: 0,
  timeoutMs: 5000,
};

function pcm(numSamples: number): Uint8Array {
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < samples.length; i++) samples[i] = ((i * 97) % 2000) - 1000;
  return new Uint8Array(samples.buffer);
}

function audioBytes(frames: AudioFrame[]): Uint8Array {
  const byteLength = frames.reduce((sum, frame) => sum + frame.data.byteLength, 0);
  const audio = new Uint8Array(byteLength);
  let offset = 0;
  for (const frame of frames) {
    const data = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    audio.set(data, offset);
    offset += data.byteLength;
  }
  return audio;
}

async function collect(instance: TTS, text = 'hello world') {
  const frames: AudioFrame[] = [];
  for await (const event of instance.synthesize(text, TEST_OPTIONS)) frames.push(event.frame);
  return frames;
}

function mockResponse(
  body: BodyInit | Uint8Array | null = pcm(4800),
  init: ResponseInit = { status: 200, headers: { 'content-type': 'audio/pcm' } },
) {
  const responseBody =
    body instanceof Uint8Array
      ? (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
      : body;
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(responseBody, init));
}

async function capturedRequest(instance: TTS, text = 'hello world') {
  const fetchMock = mockResponse();
  await collect(instance, text);
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url, init: init!, body: JSON.parse(String(init!.body)) as Record<string, unknown> };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Bland TTS options', () => {
  it('requires an API key', () => {
    vi.stubEnv('BLAND_API_KEY', '');
    expect(() => new TTS()).toThrow(/API key/);
  });

  it('accepts an API key argument', async () => {
    const { init } = await capturedRequest(new TTS({ apiKey: 'test-key' }));
    expect(new Headers(init.headers).get('authorization')).toBe('test-key');
  });

  it('reads the API key from the environment', async () => {
    vi.stubEnv('BLAND_API_KEY', 'env-key');
    const { init } = await capturedRequest(new TTS());
    expect(new Headers(init.headers).get('authorization')).toBe('env-key');
  });

  it('reports its provider and streaming capability', () => {
    const instance = new TTS({ apiKey: 'test-key' });
    expect(instance.provider).toBe('Bland');
    expect(instance.capabilities.streaming).toBe(true);
  });

  it('uses the default and custom voice IDs', async () => {
    const defaultRequest = await capturedRequest(new TTS({ apiKey: 'test-key' }));
    expect(defaultRequest.body.voice).toBe('2f29fdbb-c55e-4add-9c7c-93437ebf379d');

    vi.restoreAllMocks();
    const customRequest = await capturedRequest(
      new TTS({ apiKey: 'test-key', voiceId: 'c18a1cd5-91ef-4b06-841a-e58b8b487e8c' }),
    );
    expect(customRequest.body.voice).toBe('c18a1cd5-91ef-4b06-841a-e58b8b487e8c');
  });

  it('defaults to the native BTTS_V3 sample rate', () => {
    expect(new TTS({ apiKey: 'test-key' }).sampleRate).toBe(48000);
  });

  it.each([8000, 16000, 24000, 44100, 48000])('accepts sample rate %i', (sampleRate) => {
    expect(new TTS({ apiKey: 'test-key', sampleRate }).sampleRate).toBe(sampleRate);
  });

  it.each([12345, 22050, 0, 96000])('rejects unsupported sample rate %i', (sampleRate) => {
    expect(() => new TTS({ apiKey: 'test-key', sampleRate })).toThrow(/sampleRate must be one of/);
  });

  it('updates options while preserving omitted fields', async () => {
    const instance = new TTS({ apiKey: 'test-key' });
    instance.updateOptions({ stability: 0.25 });
    let request = await capturedRequest(instance);
    expect(request.body).toMatchObject({
      voice: '2f29fdbb-c55e-4add-9c7c-93437ebf379d',
      controls: { stability: 0.25 },
    });

    vi.restoreAllMocks();
    instance.updateOptions({
      voiceId: 'c18a1cd5-91ef-4b06-841a-e58b8b487e8c',
      expressiveness: 0.9,
      stability: 0.4,
    });
    request = await capturedRequest(instance);
    expect(request.body).toMatchObject({
      voice: 'c18a1cd5-91ef-4b06-841a-e58b8b487e8c',
      controls: { expressiveness: 0.9, stability: 0.4 },
    });
  });

  it('returns a ChunkedStream', () => {
    mockResponse();
    const stream = new TTS({ apiKey: 'test-key' }).synthesize('hello', TEST_OPTIONS);
    expect(stream).toBeInstanceOf(ChunkedStream);
    stream.close();
  });
});

describe('Bland TTS requests', () => {
  it('uses the expected endpoint and headers', async () => {
    const { url, init } = await capturedRequest(new TTS({ apiKey: 'test-key' }));
    const headers = new Headers(init.headers);
    expect(url).toBe('https://api.bland.ai/v2/tts');
    expect(headers.get('authorization')).toBe('test-key');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('normalizes a trailing slash for HTTP requests', async () => {
    const { url } = await capturedRequest(
      new TTS({ apiKey: 'test-key', baseUrl: 'https://api.bland.ai/v2/' }),
    );
    expect(url).toBe('https://api.bland.ai/v2/tts');
  });

  it('sends the default request body without undefined fields', async () => {
    const { body } = await capturedRequest(new TTS({ apiKey: 'test-key' }));
    expect(body).toEqual({
      text: 'hello world',
      voice: '2f29fdbb-c55e-4add-9c7c-93437ebf379d',
      audio: { encoding: 'pcm_s16le', sample_rate: 48000 },
    });
    expect(body).not.toHaveProperty('language');
    expect(body).not.toHaveProperty('output_format');
    expect(body).not.toHaveProperty('voice_id');
  });

  it('sends the selected sample rate', async () => {
    const { body } = await capturedRequest(new TTS({ apiKey: 'test-key', sampleRate: 24000 }));
    expect(body.audio).toEqual({ encoding: 'pcm_s16le', sample_rate: 24000 });
  });

  it('sends complete and partial controls', async () => {
    let request = await capturedRequest(
      new TTS({ apiKey: 'test-key', expressiveness: 0.9, stability: 0.4 }),
    );
    expect(request.body.controls).toEqual({ expressiveness: 0.9, stability: 0.4 });

    vi.restoreAllMocks();
    request = await capturedRequest(new TTS({ apiKey: 'test-key', stability: 0.4 }));
    expect(request.body.controls).toEqual({ stability: 0.4 });
  });
});

describe('Bland TTS audio', () => {
  it('emits bare PCM unchanged at the selected sample rate', async () => {
    const payload = pcm(4800);
    mockResponse(payload);
    const frames = await collect(new TTS({ apiKey: 'test-key' }));
    expect(audioBytes(frames)).toEqual(payload);
    expect(frames.map((frame) => frame.sampleRate)).toEqual([48000]);
    expect(Buffer.from(audioBytes(frames)).subarray(0, 4).toString()).not.toBe('RIFF');
  });

  it('reassembles audio split across odd-byte chunks', async () => {
    const payload = pcm(4800);
    const splits = [1, 3, 1000, 2001, payload.length];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let start = 0;
        for (const end of splits) {
          controller.enqueue(payload.slice(start, end));
          start = end;
        }
        controller.close();
      },
    });
    mockResponse(body);
    expect(audioBytes(await collect(new TTS({ apiKey: 'test-key' })))).toEqual(payload);
  });

  it('honors a requested sample rate end to end', async () => {
    const payload = pcm(2400);
    const fetchMock = mockResponse(payload);
    const frames = await collect(new TTS({ apiKey: 'test-key', sampleRate: 24000 }));
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      audio: { sample_rate: number };
    };
    expect(request.audio.sample_rate).toBe(24000);
    expect(frames.map((frame) => frame.sampleRate)).toEqual([24000]);
    expect(audioBytes(frames)).toEqual(payload);
  });
});

describe('Bland TTS errors', () => {
  async function emittedError(instance: TTS): Promise<Error> {
    const originalEmit = process.emit.bind(process) as (
      event: string | symbol,
      ...args: unknown[]
    ) => boolean;
    const emitSpy = vi.spyOn(process, 'emit').mockImplementation(((event, ...args) => {
      if (event === 'unhandledRejection' && args[0] instanceof APIStatusError) return true;
      return originalEmit(event, ...args);
    }) as typeof process.emit);
    const error = new Promise<Error>((resolve) => {
      instance.once('error', (event) => resolve(event.error));
    });
    try {
      await collect(instance);
      await new Promise((resolve) => setImmediate(resolve));
      return error;
    } finally {
      emitSpy.mockRestore();
    }
  }

  it('unwraps Bland error envelopes into APIStatusError', async () => {
    mockResponse(
      JSON.stringify({ error: { code: 'voice_not_found', message: 'Voice was not found.' } }),
      {
        status: 404,
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-id' },
      },
    );
    const error = await emittedError(new TTS({ apiKey: 'test-key' }));
    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(404);
    expect(error.message).toContain('voice_not_found');
    expect(error.message).toContain('Voice was not found.');
  });

  it('raises APIStatusError for non-JSON responses', async () => {
    mockResponse('<html>gateway</html>', { status: 502, statusText: 'Bad Gateway' });
    const error = await emittedError(new TTS({ apiKey: 'test-key' }));
    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(502);
  });
});

interface BlandServerOptions {
  frames?: Buffer[];
  initError?: Record<string, unknown>;
  turnError?: Record<string, unknown>;
  endReason?: string;
  staleTerminator?: boolean;
  readyEncoding?: string;
  readySampleRate?: number;
  handshakeStatus?: number;
  acknowledgeCancel?: boolean;
}

class BlandWebSocketServer {
  readonly received: Record<string, unknown>[] = [];
  readonly startedContexts = new Set<string>();
  headers: Record<string, string | string[] | undefined> = {};
  sessions = 0;
  baseUrl = '';
  speakReceived = promiseSignal();
  cancelReceived = promiseSignal();
  connectionClosed = promiseSignal();
  #options: BlandServerOptions;
  #wss?: WebSocketServer;

  constructor(options: BlandServerOptions = {}) {
    this.#options = options;
  }

  async start(): Promise<this> {
    this.#wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: '/v2/tts/ws',
      verifyClient: (_info, callback) => {
        if (this.#options.handshakeStatus !== undefined) {
          callback(false, this.#options.handshakeStatus, 'Unauthorized', {
            'x-request-id': 'upgrade-request-id',
          });
        } else {
          callback(true);
        }
      },
    });
    await once(this.#wss, 'listening');
    const address = this.#wss.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    this.baseUrl = `http://127.0.0.1:${address.port}/v2`;
    this.#wss.on('connection', (ws, request) => this.#handle(ws, request.headers));
    return this;
  }

  #handle(ws: ServerWebSocket, headers: Record<string, string | string[] | undefined>): void {
    this.headers = headers;
    this.sessions++;
    ws.on('close', () => this.connectionClosed.resolve());
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      this.received.push(message);
      const type = message.type;
      const contextId = String(message.context_id ?? '');
      if (type === 'init') {
        if (this.#options.initError) {
          ws.send(JSON.stringify({ type: 'error', ...this.#options.initError }));
          ws.close();
          return;
        }
        const audio = message.audio as Record<string, unknown>;
        ws.send(
          JSON.stringify({
            type: 'ready',
            session_id: 'test-session',
            encoding: this.#options.readyEncoding ?? 'pcm_s16le',
            sample_rate: this.#options.readySampleRate ?? audio.sample_rate,
          }),
        );
      } else if (type === 'speak') {
        this.speakReceived.resolve();
        if (this.#options.turnError) {
          ws.send(
            JSON.stringify({ type: 'error', context_id: contextId, ...this.#options.turnError }),
          );
        } else if (!this.startedContexts.has(contextId)) {
          this.startedContexts.add(contextId);
          ws.send(JSON.stringify({ type: 'utterance_start', context_id: contextId }));
        }
      } else if (type === 'end_of_turn' && !this.#options.turnError) {
        for (const frame of this.#options.frames ?? [Buffer.from(pcm(480))]) ws.send(frame);
        if (this.#options.staleTerminator) {
          ws.send(
            JSON.stringify({
              type: 'utterance_end',
              context_id: 'someone-else',
              reason: 'cancelled',
            }),
          );
        }
        ws.send(
          JSON.stringify({
            type: 'utterance_end',
            context_id: contextId,
            reason: this.#options.endReason ?? 'complete',
          }),
        );
      } else if (type === 'cancel') {
        this.cancelReceived.resolve();
        if (this.#options.acknowledgeCancel !== false) {
          ws.send(
            JSON.stringify({
              type: 'utterance_end',
              context_id: contextId,
              reason: 'cancelled',
            }),
          );
        }
      } else if (type === 'close') {
        ws.send(JSON.stringify({ type: 'done', session_id: 'test-session' }));
        ws.close();
      }
    });
  }

  ofType(type: string): Record<string, unknown>[] {
    return this.received.filter((message) => message.type === type);
  }

  async close(): Promise<void> {
    if (!this.#wss) return;
    for (const client of this.#wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.#wss!.close(() => resolve()));
  }
}

function promiseSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function streamTurn(
  instance: TTS,
  tokens: string[],
  options = TEST_OPTIONS,
): Promise<Uint8Array> {
  instance.on('error', () => {});
  const stream = instance.stream({ connOptions: options });
  for (const token of tokens) stream.pushText(token);
  stream.endInput();
  const frames: AudioFrame[] = [];
  for await (const event of stream) {
    if (event !== SynthesizeStream.END_OF_STREAM) frames.push(event.frame);
  }
  return audioBytes(frames);
}

async function streamingError(
  instance: TTS,
  tokens = ['hello'],
  options = TEST_OPTIONS,
): Promise<APIError> {
  const error = new Promise<APIError>((resolve) => {
    instance.once('error', (event) => resolve(event.error as APIError));
  });
  await streamTurn(instance, tokens, options);
  return await error;
}

describe('Bland TTS websocket', () => {
  it('derives the websocket endpoint from the HTTP base URL', async () => {
    const server = await new BlandWebSocketServer().start();
    const instance = new TTS({ apiKey: 'k', baseUrl: `${server.baseUrl}/` });
    try {
      await streamTurn(instance, ['hello']);
      expect(server.sessions).toBe(1);
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('returns a SynthesizeStream', async () => {
    const instance = new TTS({ apiKey: 'test-key' });
    const stream = instance.stream();
    expect(stream).toBeInstanceOf(SynthesizeStream);
    stream.close();
    await instance.close();
  });

  it('sends init once with voice, format, controls, and Bearer auth', async () => {
    const server = await new BlandWebSocketServer().start();
    const instance = new TTS({ apiKey: 'test-key', baseUrl: server.baseUrl });
    try {
      await streamTurn(instance, ['hello world']);
      await instance.close();
      expect(server.ofType('init')).toEqual([
        {
          type: 'init',
          voice: '2f29fdbb-c55e-4add-9c7c-93437ebf379d',
          audio: { encoding: 'pcm_s16le', sample_rate: 48000 },
        },
      ]);
      expect(server.headers.authorization).toBe('Bearer test-key');
    } finally {
      await instance.close();
      await server.close();
    }

    const controlsServer = await new BlandWebSocketServer().start();
    const controlled = new TTS({
      apiKey: 'k',
      baseUrl: controlsServer.baseUrl,
      expressiveness: 0.9,
      stability: 0.4,
    });
    try {
      await streamTurn(controlled, ['hello']);
      expect(controlsServer.ofType('init')[0]?.controls).toEqual({
        expressiveness: 0.9,
        stability: 0.4,
      });
    } finally {
      await controlled.close();
      await controlsServer.close();
    }
  });

  it('streams deltas verbatim and ignores flushes', async () => {
    const server = await new BlandWebSocketServer().start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      const stream = instance.stream({ connOptions: TEST_OPTIONS });
      instance.on('error', () => {});
      stream.pushText('The weather');
      stream.flush();
      stream.pushText(' is clear');
      stream.pushText(' today.');
      stream.endInput();
      for await (const _event of stream) {
        // drain
      }
      expect(server.ofType('speak').map((message) => message.text)).toEqual([
        'The weather',
        ' is clear',
        ' today.',
      ]);
      expect(server.ofType('end_of_turn')).toHaveLength(1);
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('completes an empty stream without creating a turn', async () => {
    const server = await new BlandWebSocketServer().start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      expect(await streamTurn(instance, [])).toHaveLength(0);
      expect(server.ofType('speak')).toEqual([]);
      expect(server.ofType('end_of_turn')).toEqual([]);
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('uses one context per turn and reuses the session', async () => {
    const server = await new BlandWebSocketServer().start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      await streamTurn(instance, ['first.']);
      await streamTurn(instance, ['second.']);
      await streamTurn(instance, ['third.']);
      const speaks = server.ofType('speak');
      const ends = server.ofType('end_of_turn');
      expect(new Set(speaks.map((message) => message.context_id)).size).toBe(3);
      expect(ends.map((message) => message.context_id)).toEqual(
        speaks.map((message) => message.context_id),
      );
      expect(server.sessions).toBe(1);
      expect(server.ofType('init')).toHaveLength(1);
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('emits binary PCM unchanged and ignores stale terminals', async () => {
    const frames = [Buffer.from(pcm(480)), Buffer.from(pcm(480)), Buffer.from(pcm(240))];
    const server = await new BlandWebSocketServer({ frames, staleTerminator: true }).start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      expect(await streamTurn(instance, ['hello'])).toEqual(new Uint8Array(Buffer.concat(frames)));
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('settles the session on close', async () => {
    const server = await new BlandWebSocketServer().start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      await streamTurn(instance, ['hello']);
      await instance.close();
      expect(server.ofType('close')).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('cancels an abandoned turn and reuses a cleanly drained connection', async () => {
    const server = await new BlandWebSocketServer().start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      instance.on('error', () => {});
      const stream = instance.stream({ connOptions: TEST_OPTIONS });
      stream.pushText('hello');
      await server.speakReceived.promise;
      const contextId = server.ofType('speak')[0]?.context_id;
      stream.close();
      await server.cancelReceived.promise;
      await new Promise((resolve) => setImmediate(resolve));
      await streamTurn(instance, ['replacement']);
      expect(server.ofType('cancel')).toEqual([{ type: 'cancel', context_id: contextId }]);
      expect(server.sessions).toBe(1);
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('discards a connection when cancel is not acknowledged', async () => {
    const server = await new BlandWebSocketServer({ acknowledgeCancel: false }).start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      instance.on('error', () => {});
      const stream = instance.stream({ connOptions: { ...TEST_OPTIONS, timeoutMs: 50 } });
      stream.pushText('hello');
      await server.speakReceived.promise;
      stream.close();
      await server.connectionClosed.promise;
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('requires a matching complete terminal', async () => {
    const server = await new BlandWebSocketServer({ endReason: 'failed' }).start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      const error = await streamingError(instance);
      expect(error).toBeInstanceOf(APIError);
      expect(error.message).toContain('failed');
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('maps fatal and retryable Bland turn errors', async () => {
    const fatalServer = await new BlandWebSocketServer({
      turnError: { code: 'insufficient_credits', message: 'Your account is out of credits.' },
    }).start();
    const fatalTts = new TTS({ apiKey: 'k', baseUrl: fatalServer.baseUrl });
    try {
      const error = await streamingError(fatalTts);
      expect(error.message).toContain('insufficient_credits');
      expect(error.message).toContain('Your account is out of credits.');
      expect(error.retryable).toBe(false);
    } finally {
      await fatalTts.close();
      await fatalServer.close();
    }

    const retryServer = await new BlandWebSocketServer({
      turnError: { code: 'synthesis_failed', message: 'Synthesis failed.' },
    }).start();
    const retryTts = new TTS({ apiKey: 'k', baseUrl: retryServer.baseUrl });
    try {
      expect((await streamingError(retryTts)).retryable).toBe(true);
    } finally {
      await retryTts.close();
      await retryServer.close();
    }
  });

  it('surfaces rejected init errors', async () => {
    const server = await new BlandWebSocketServer({
      initError: { code: 'voice_not_found', message: 'Voice was not found.' },
    }).start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      expect((await streamingError(instance)).message).toContain('voice_not_found');
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('preserves pre-upgrade HTTP status and request ID', async () => {
    const server = await new BlandWebSocketServer({ handshakeStatus: 401 }).start();
    const instance = new TTS({ apiKey: 'bad-key', baseUrl: server.baseUrl });
    try {
      const error = await streamingError(instance);
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
      expect((error as APIStatusError).requestId).toBe('upgrade-request-id');
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it.each([
    ['mulaw', 48000],
    ['pcm_s16le', 24000],
  ])('rejects ready format %s/%i', async (encoding, sampleRate) => {
    const server = await new BlandWebSocketServer({
      readyEncoding: encoding,
      readySampleRate: sampleRate,
    }).start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      const error = await streamingError(instance);
      expect(error.message).toContain('unexpected audio format');
      expect(error.retryable).toBe(false);
      await server.connectionClosed.promise;
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('invalidates a session whenever a supported option is supplied', async () => {
    const server = await new BlandWebSocketServer().start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      await streamTurn(instance, ['hello']);
      instance.updateOptions({ voiceId: 'c18a1cd5-91ef-4b06-841a-e58b8b487e8c' });
      await streamTurn(instance, ['hello again']);
      expect(server.ofType('init')).toHaveLength(2);
      expect(server.ofType('init')[1]?.voice).toBe('c18a1cd5-91ef-4b06-841a-e58b8b487e8c');
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('does not invalidate when no options are supplied', async () => {
    const server = await new BlandWebSocketServer().start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      await streamTurn(instance, ['first']);
      instance.updateOptions();
      await streamTurn(instance, ['second']);
      expect(server.sessions).toBe(1);
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('discards a refused turn instead of contaminating the next one', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/v2/tts/ws' });
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    let sessions = 0;
    const speaks: Record<string, unknown>[] = [];
    const twoSpeaks = promiseSignal();
    wss.on('connection', (ws) => {
      sessions++;
      ws.on('error', () => {});
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === 'init') {
          ws.send(
            JSON.stringify({
              type: 'ready',
              session_id: `session-${sessions}`,
              encoding: 'pcm_s16le',
              sample_rate: 48000,
            }),
          );
        } else if (message.type === 'speak') {
          speaks.push(message);
          if (speaks.length === 2) twoSpeaks.resolve();
        } else if (message.type === 'cancel') {
          for (const contextId of new Set(speaks.map((speak) => speak.context_id))) {
            ws.send(
              JSON.stringify({
                type: 'error',
                context_id: contextId,
                code: 'insufficient_credits',
                message: 'wallet depleted',
              }),
            );
          }
        }
      });
    });

    const instance = new TTS({
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${address.port}/v2`,
    });
    instance.on('error', () => {});
    try {
      const refused = instance.stream({ connOptions: TEST_OPTIONS });
      refused.pushText('first');
      refused.pushText(' second');
      await twoSpeaks.promise;
      refused.close();
      await vi.waitFor(() => expect(wss.clients.size).toBe(0), { timeout: 2000 });

      const replacement = instance.stream({
        connOptions: { ...TEST_OPTIONS, timeoutMs: 100 },
      });
      replacement.pushText('replacement');
      replacement.endInput();
      for await (const _event of replacement) {
        // A fresh session may time out, but it must not consume the refused turn's error.
      }
      expect(sessions).toBe(2);
    } finally {
      await instance.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('keeps a failed cancel as cancellation without replaying text', async () => {
    const server = await new BlandWebSocketServer({ acknowledgeCancel: false }).start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      instance.on('error', () => {});
      const stream = instance.stream({
        connOptions: { ...TEST_OPTIONS, maxRetry: 3, timeoutMs: 50 },
      });
      stream.pushText('hello');
      await server.speakReceived.promise;
      stream.close();
      await server.connectionClosed.promise;
      expect(server.ofType('speak').map((message) => message.text)).toEqual(['hello']);
    } finally {
      await instance.close();
      await server.close();
    }
  });

  it('uses a fixed 500ms cancellation drain independent of connect timeout', async () => {
    const server = await new BlandWebSocketServer({ acknowledgeCancel: false }).start();
    const instance = new TTS({ apiKey: 'k', baseUrl: server.baseUrl });
    try {
      instance.on('error', () => {});
      const stream = instance.stream({
        connOptions: { ...TEST_OPTIONS, timeoutMs: 30_000 },
      });
      stream.pushText('hello');
      await server.speakReceived.promise;
      const started = performance.now();
      stream.close();
      await server.connectionClosed.promise;
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      await instance.close();
      await server.close();
    }
  });
});

describe('Bland TTS with streaming disabled', () => {
  it('allocates no pool and refuses streams with useful guidance', async () => {
    const instance = new TTS({ apiKey: 'k', streaming: false });
    expect(instance.capabilities.streaming).toBe(false);
    expect(() => instance.stream()).toThrow(
      /streaming is disabled.*streaming: true.*StreamAdapter/i,
    );
    instance.prewarm();
    await instance.close();
  });

  it('leaves HTTP synthesis available', () => {
    const instance = new TTS({ apiKey: 'k', streaming: false });
    const stream = instance.synthesize('hello', TEST_OPTIONS);
    expect(stream).toBeInstanceOf(ChunkedStream);
    stream.close();
  });

  it('is enabled by default', async () => {
    const instance = new TTS({ apiKey: 'k' });
    expect(instance.capabilities.streaming).toBe(true);
    await instance.close();
  });
});

const hasBlandConfig = Boolean(process.env.BLAND_API_KEY && process.env.OPENAI_API_KEY);
if (hasBlandConfig) {
  describe('Bland TTS integration', async () => {
    await testTTS(new TTS(), new STT(), { streaming: true });
  });
} else {
  describe('Bland TTS integration', () => {
    it.skip('requires BLAND_API_KEY and OPENAI_API_KEY', () => {});
  });
}
