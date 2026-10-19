// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  type APIError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
} from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS, toFinesseLanguage } from './tts.js';

const hasFinesseConfig = Boolean(
  process.env.FINESSE_API_KEY && process.env.FINESSE_VOICE_ID && process.env.OPENAI_API_KEY,
);

if (hasFinesseConfig) {
  describe('Finesse', async () => {
    await testTts(new TTS({ voice: process.env.FINESSE_VOICE_ID! }), new STT());
  });
} else {
  describe('Finesse', () => {
    it.skip('requires FINESSE_API_KEY, FINESSE_VOICE_ID and OPENAI_API_KEY', () => {});
  });
}

const API_KEY = 'flv_test_key_do_not_log';
const VOICE = '665f1a2b3c4d5e6f7a8b9c0d';
const CHUNK = Buffer.alloc(4800, 1); // 100 ms of 24 kHz s16le
const NO_RETRY: APIConnectOptions = { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 };

type Frame = Record<string, unknown>;

/**
 * A local server that speaks the Finesse protocol: for each context it sends task_started, then
 * pairs of an audio_chunk event and the binary PCM frame it announces, then task_done once the
 * client finalizes the context.
 */
class FakeFinesse {
  wss!: WebSocketServer;
  url = '';
  received: Frame[] = [];
  frameBytes: number[] = [];
  requests: IncomingMessage[] = [];
  connections = 0;
  rejectStatus?: number;
  answerFinalize = true;
  onTask?: (ws: WebSocket, ctx: string) => void;

  async start(): Promise<void> {
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      handleProtocols: (protocols) => (protocols.has('finesse.v1') ? 'finesse.v1' : false),
      verifyClient: (_info, done) => {
        if (this.rejectStatus) done(false, this.rejectStatus);
        else done(true);
      },
    });
    await once(this.wss, 'listening');
    this.url = `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
    this.wss.on('connection', (ws, req) => {
      this.connections++;
      this.requests.push(req);
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const text = raw.toString();
        this.frameBytes.push(Buffer.byteLength(text));
        const msg = JSON.parse(text) as Frame;
        this.received.push(msg);
        const ctx = String(msg.context_id ?? '');
        if (msg.type === 'task_start') {
          if (this.onTask) this.onTask(ws, ctx);
          else answer(ws, ctx);
        }
        if (msg.finalize && this.answerFinalize) {
          ws.send(JSON.stringify({ type: 'task_done', context_id: ctx }));
        }
      });
    });
  }

  types(): string[] {
    return this.received.map((m) => String(m.type));
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

const answer = (ws: WebSocket, ctx: string, chunks = 2) => {
  ws.send(JSON.stringify({ type: 'task_started', context_id: ctx, sample_rate: 24000 }));
  for (let i = 0; i < chunks; i++) {
    ws.send(JSON.stringify({ type: 'audio_chunk', context_id: ctx, chunk_index: i }));
    ws.send(CHUNK);
  }
  ws.send(JSON.stringify({ type: 'sentence_done', context_id: ctx }));
};

let server: FakeFinesse;
let finesse: TTS | undefined;

const makeTTS = async (opts: Partial<ConstructorParameters<typeof TTS>[0]> = {}) => {
  server = new FakeFinesse();
  await server.start();
  finesse = new TTS({ apiKey: API_KEY, voice: VOICE, ...opts });
  finesse._wsUrl = server.url;
  return finesse;
};

afterEach(async () => {
  await finesse?.close();
  finesse = undefined;
  await server?.stop();
});

const collect = async (stream: AsyncIterable<tts.SynthesizedAudio | symbol>): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const ev of stream) {
    if (ev === tts.SynthesizeStream.END_OF_STREAM) break;
    const audio = ev as tts.SynthesizedAudio;
    chunks.push(
      Buffer.from(
        audio.frame.data.buffer,
        audio.frame.data.byteOffset,
        audio.frame.data.byteLength,
      ),
    );
  }
  return Buffer.concat(chunks);
};

const errorOf = async (t: TTS, run: () => void): Promise<APIError> => {
  const event = once(t, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;
  run();
  const [{ error }] = await event;
  return error as APIError;
};

const until = async (check: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('configuration', () => {
  it('requires an API key', () => {
    const saved = process.env.FINESSE_API_KEY;
    delete process.env.FINESSE_API_KEY;
    try {
      expect(() => new TTS({ voice: VOICE })).toThrow(/API key/);
    } finally {
      if (saved !== undefined) process.env.FINESSE_API_KEY = saved;
    }
  });

  it('reads the API key from the environment', () => {
    const saved = process.env.FINESSE_API_KEY;
    process.env.FINESSE_API_KEY = 'flv_env';
    try {
      expect(new TTS({ voice: VOICE }).provider).toBe('Finesse');
    } finally {
      if (saved === undefined) delete process.env.FINESSE_API_KEY;
      else process.env.FINESSE_API_KEY = saved;
    }
  });

  it('uses 24 kHz mono and streams', () => {
    const t = new TTS({ apiKey: API_KEY, voice: VOICE });
    expect(t.sampleRate).toBe(24000);
    expect(t.numChannels).toBe(1);
    expect(t.capabilities.streaming).toBe(true);
  });

  it.each([
    [{ voice: '  ' }, /voice/],
    [{ sampleRate: 16000 }, /sampleRate/],
    [{ sampleRate: 96000 }, /sampleRate/],
    [{ numStep: 0 }, /numStep/],
    [{ guidanceScale: 11 }, /guidanceScale/],
    [{ lengthScale: 0 }, /lengthScale/],
    [{ idleFlushMs: 100 }, /idleFlushMs/],
  ])('rejects %o', (opts, match) => {
    expect(() => new TTS({ apiKey: API_KEY, voice: VOICE, ...opts })).toThrow(match);
  });

  it('rejects invalid updates without changing anything', async () => {
    const t = await makeTTS();
    expect(() => t.updateOptions({ voice: 'other', lengthScale: 0 })).toThrow(/lengthScale/);
    const stream = t.stream({ connOptions: NO_RETRY });
    stream.pushText('Hi.');
    stream.endInput();
    await collect(stream);
    expect(server.received[0]!.voice_id).toBe(VOICE);
    expect(server.received[0]!.length_scale).toBeUndefined();
  });

  it.each([
    ['en', 'en'],
    ['hi-IN', 'hi'],
    ['tamil', 'ta'],
    ['ar', 'arb'],
    ['ar-SA', 'arb'],
    ['ar-EG', 'arz'],
    ['ar-AE', 'afb'],
    ['ar-KW', 'afb'],
    ['ne-NP', 'npi'],
    ['no', 'nb'],
    ['or-IN', 'ory'],
    ['arz', 'arz'],
    ['ars', 'ars'],
    ['yue', 'yue'],
    ['mni', 'mni'],
  ])('maps the language %s to %s', (language, expected) => {
    expect(toFinesseLanguage(language)).toBe(expected);
  });
});

describe('streaming', () => {
  it('sends text as it arrives and finalizes the context', async () => {
    const t = await makeTTS({ language: 'hi', numStep: 16 });
    const stream = t.stream({ connOptions: NO_RETRY });
    stream.pushText('Hello');
    stream.pushText(' world.');
    stream.flush();
    stream.endInput();

    const audio = await collect(stream);

    expect(audio.equals(Buffer.concat([CHUNK, CHUNK]))).toBe(true);
    expect(server.types()).toEqual(['task_start', 'task_continue', 'task_continue']);
    const [start, more, final] = server.received;
    expect(start).toEqual({
      type: 'task_start',
      context_id: start!.context_id,
      voice_id: VOICE,
      text: 'Hello',
      finalize: false,
      language: 'hi',
      output_format: 's16le',
      sample_rate: 24000,
      num_step: 16,
    });
    expect(more).toEqual({
      type: 'task_continue',
      context_id: start!.context_id,
      text: ' world.',
      finalize: false,
    });
    expect(final).toEqual({
      type: 'task_continue',
      context_id: start!.context_id,
      text: '',
      finalize: true,
    });
    const req = server.requests[0]!;
    expect(req.headers['sec-websocket-protocol']).toBe('finesse.v1');
    expect(req.headers['x-api-key']).toBe(API_KEY);
    expect(String(req.headers['x-finesse-client'])).toMatch(/^livekit-agents-js\//);
  });

  it('waits for real text before opening the context', async () => {
    const t = await makeTTS();
    const stream = t.stream({ connOptions: NO_RETRY });
    stream.pushText('  ');
    stream.pushText('Hi.');
    stream.endInput();
    await collect(stream);
    expect(server.received[0]).toMatchObject({ type: 'task_start', text: '  Hi.' });
  });

  it('sends nothing for a stream without text', async () => {
    const t = await makeTTS();
    const stream = t.stream({ connOptions: NO_RETRY });
    stream.endInput();
    expect((await collect(stream)).length).toBe(0);
    expect(server.received).toEqual([]);
  });

  it('drops audio for other contexts', async () => {
    const t = await makeTTS();
    server.onTask = (ws, ctx) => {
      // The tail of an earlier, cancelled context arrives first on a reused connection.
      ws.send(JSON.stringify({ type: 'audio_chunk', context_id: 'stale' }));
      ws.send(Buffer.alloc(4800, 9));
      ws.send(JSON.stringify({ type: 'task_done', context_id: 'stale' }));
      answer(ws, ctx, 1);
    };
    const stream = t.stream({ connOptions: NO_RETRY });
    stream.pushText('Hi.');
    stream.endInput();
    expect((await collect(stream)).equals(CHUNK)).toBe(true);
  });

  it('reuses one connection across streams', async () => {
    const t = await makeTTS();
    for (const text of ['One.', 'Two.']) {
      const stream = t.stream({ connOptions: NO_RETRY });
      stream.pushText(text);
      stream.endInput();
      await collect(stream);
    }
    expect(server.connections).toBe(1);
    const starts = server.received.filter((m) => m.type === 'task_start');
    expect(starts.map((m) => m.text)).toEqual(['One.', 'Two.']);
    expect(starts[0]!.context_id).not.toBe(starts[1]!.context_id);
  });

  it('cancels the context on the server when the stream is interrupted', async () => {
    const t = await makeTTS();
    let started = false;
    server.onTask = (ws, ctx) => {
      ws.send(JSON.stringify({ type: 'task_started', context_id: ctx }));
      ws.send(JSON.stringify({ type: 'audio_chunk', context_id: ctx }));
      ws.send(CHUNK);
      started = true; // then keep the turn open, as a long reply would
    };
    const stream = t.stream({ connOptions: NO_RETRY });
    stream.pushText('A long reply that the user talks over.');
    await until(() => started);
    stream.close();

    await until(() => server.types().includes('task_cancel'));
    const start = server.received[0]!;
    expect(server.received).toContainEqual({ type: 'task_cancel', context_id: start.context_id });
  });

  it('keeps speaking through a pause in the text longer than the timeout', async () => {
    const t = await makeTTS();
    const stream = t.stream({ connOptions: { ...NO_RETRY, timeoutMs: 300 } });
    stream.pushText('Let me check that for you.');
    setTimeout(() => {
      // e.g. a tool call, well past the 300 ms timeout
      stream.pushText(' Your order shipped today.');
      stream.endInput();
    }, 1000);

    const audio = await collect(stream);

    expect(audio.length).toBe(2 * CHUNK.length);
    expect(server.received.map((m) => m.text)).toEqual([
      'Let me check that for you.',
      ' Your order shipped today.',
      '',
    ]);
  });

  it('times out once the input is finalized and the server stalls', async () => {
    const t = await makeTTS();
    server.answerFinalize = false;
    const error = await errorOf(t, () => {
      const stream = t.stream({ connOptions: { ...NO_RETRY, timeoutMs: 300 } });
      stream.pushText('Hello.');
      stream.endInput();
      void collect(stream);
    });
    expect(error).toBeInstanceOf(APITimeoutError);
  });

  it('synthesizes a whole text as one finalized context', async () => {
    const t = await makeTTS();
    const audio = await collect(t.synthesize('Hello there.', NO_RETRY));
    expect(audio.length).toBeGreaterThanOrEqual(2 * CHUNK.length);
    expect(server.types()).toEqual(['task_start', 'task_continue']);
    expect(server.received[0]).toMatchObject({ text: 'Hello there.', finalize: false });
    expect(server.received[1]).toMatchObject({ text: '', finalize: true });
  });

  it.each(['😀', '\u0001', 'नमस्ते'])(
    'splits long %j text into frames under 1 MiB',
    async (char) => {
      const t = await makeTTS();
      const text = char.repeat(200_000).slice(0, 200_000);
      await collect(t.synthesize(text, NO_RETRY));
      expect(server.received.map((m) => m.text).join('')).toBe(text);
      expect(Math.max(...server.frameBytes)).toBeLessThan(1024 * 1024);
    },
  );
});

describe('errors', () => {
  const failWith = async (event: Frame) => {
    const t = await makeTTS();
    server.onTask = (ws, ctx) => ws.send(JSON.stringify({ ...event, context_id: ctx }));
    return errorOf(t, () => {
      const stream = t.stream({ connOptions: NO_RETRY });
      stream.pushText('Hello.');
      stream.endInput();
      void collect(stream);
    });
  };

  it.each([
    [{ type: 'task_failed', code: 'voice_not_found' }, false],
    [{ type: 'error', code: 'insufficient_credits', fatal: true }, false],
    [{ type: 'error', code: 'upstream_closed', fatal: true }, true],
  ])('maps %o to retryable=%s', async (event, retryable) => {
    const error = await failWith(event);
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error.body).toEqual({ code: event.code });
    expect(error.retryable).toBe(retryable);
  });

  it('reports a context the server cancelled', async () => {
    const error = await failWith({ type: 'task_cancelled' });
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error.message).toMatch(/cancelled/);
  });

  it('does not report error codes that are not identifiers', async () => {
    const error = await failWith({ type: 'task_failed', code: 'Hello, this is speech' });
    expect(error.body).toEqual({ code: 'unknown_error' });
    expect(error.message).not.toContain('speech');
  });

  it.each([
    [1000, true],
    [1011, true],
    [1013, true],
    [1008, false],
    [1009, false],
  ])('treats an unexpected close %i as retryable=%s', async (code, retryable) => {
    const t = await makeTTS();
    server.onTask = (ws) => ws.close(code);
    const error = await errorOf(t, () => {
      const stream = t.stream({ connOptions: NO_RETRY });
      stream.pushText('Hello.');
      stream.endInput();
      void collect(stream);
    });
    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(code);
    expect(error.retryable).toBe(retryable);
  });

  it.each([
    [401, false],
    [429, true],
    [503, true],
  ])('reports a refused handshake %i without the API key', async (status, retryable) => {
    const t = await makeTTS();
    server.rejectStatus = status;
    const error = await errorOf(t, () => {
      const stream = t.stream({ connOptions: NO_RETRY });
      stream.pushText('Hello.');
      stream.endInput();
      void collect(stream);
    });
    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(status);
    expect(error.retryable).toBe(retryable);
    expect(error.message).not.toContain(API_KEY);
    expect(error.toString()).not.toContain(API_KEY);
  });
});
