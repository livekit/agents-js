// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
} from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS, type TTSOptions, _toVartalaapBody } from './tts.js';

const hasVartalaapConfig = Boolean(process.env.VARTALAAP_API_KEY && process.env.OPENAI_API_KEY);

if (hasVartalaapConfig) {
  describe('Vartalaap', async () => {
    await testTts(new TTS(), new STT());
  });
} else {
  describe('Vartalaap', () => {
    it.skip('requires VARTALAAP_API_KEY and OPENAI_API_KEY', () => {});
  });
}

// One 80 ms frame of 24 kHz mono s16le, the size of the server's first binary message.
const FRAME_BYTES = 3840;
const STALE_CHUNK = Buffer.alloc(FRAME_BYTES, 7);

const TEST_TTS_OPTIONS: TTSOptions = {
  model: 'narad',
  voice: 'saanvi',
  expression: 'neutral',
  digits: 'auto',
  raw: false,
  sampleRate: 24000,
  apiKey: 'test-key',
  baseUrl: 'https://api.vartaloop.ai',
  chunkTimeout: 5000,
};

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

interface Utterance {
  text: string;
  voice: string;
  request_id: string;
  style?: string;
  [key: string]: unknown;
}

// A minimal Vartalaap TTS WebSocket server: for every utterance it replies with start, two
// binary frames (with a first_audio_ms event between them) and end, all tagged with the
// utterance's request_id. `onUtterance` lets a test override the reply (e.g. to simulate a
// provider failure); return false to suppress the normal reply. `onConnection` runs before any
// utterance arrives.
function serveVartalaap(
  wss: WebSocketServer,
  {
    onUtterance,
    onConnection,
    audio = (n: number) => Buffer.alloc(FRAME_BYTES, n),
  }: {
    onUtterance?: (ws: WebSocket, utterance: Utterance, connectionNumber: number) => boolean;
    onConnection?: (ws: WebSocket, connectionNumber: number) => void;
    audio?: (utteranceNumber: number) => Buffer;
  } = {},
): { connectionCount: () => number; utterances: Utterance[] } {
  let connectionCount = 0;
  const utterances: Utterance[] = [];
  wss.on('connection', (ws) => {
    connectionCount++;
    const connectionNumber = connectionCount;
    onConnection?.(ws, connectionNumber);
    ws.on('message', (raw) => {
      const utterance = JSON.parse(raw.toString()) as Utterance;
      utterances.push(utterance);
      if (onUtterance && !onUtterance(ws, utterance, connectionNumber)) return;
      const requestId = utterance.request_id;
      const n = utterances.length;
      ws.send(JSON.stringify({ type: 'start', request_id: requestId, voice: utterance.voice }));
      ws.send(audio(n), { binary: true });
      ws.send(JSON.stringify({ type: 'first_audio_ms', request_id: requestId, chunk: 0, ms: 40 }));
      ws.send(audio(n), { binary: true });
      ws.send(JSON.stringify({ type: 'end', request_id: requestId, audio_s: 0.16 }));
    });
  });
  return { connectionCount: () => connectionCount, utterances };
}

async function synthesizeTurn(
  vartalaap: TTS,
  texts: string[],
  connOptions?: APIConnectOptions,
): Promise<tts.SynthesizedAudio[]> {
  const stream = vartalaap.stream({ connOptions });
  for (const text of texts) {
    stream.pushText(text);
  }
  stream.endInput();

  try {
    const events: tts.SynthesizedAudio[] = [];
    for await (const event of stream) {
      if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
    }
    return events;
  } finally {
    stream.close();
  }
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for promise')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function audioOf(events: tts.SynthesizedAudio[]): Buffer {
  return Buffer.concat(
    events.map((event) =>
      Buffer.from(
        event.frame.data.buffer,
        event.frame.data.byteOffset,
        event.frame.data.byteLength,
      ),
    ),
  );
}

describe('Vartalaap request body', () => {
  it('sends only the non-default fields and never the model', () => {
    const body = _toVartalaapBody(TEST_TTS_OPTIONS, 'namaste.', 'req-1');
    expect(body).toEqual({
      text: 'namaste.',
      voice: 'saanvi',
      format: 'pcm16',
      request_id: 'req-1',
      digits: 'auto',
    });
    expect(body).not.toHaveProperty('model');

    const full = _toVartalaapBody(
      {
        ...TEST_TTS_OPTIONS,
        voice: 'sahil',
        expression: 'excited',
        digits: 'mixed',
        speed: 1.2,
        temperature: 0.5,
        seed: 42,
        postfx: false,
        profile: 'telephony',
        raw: true,
      },
      'OTP 4321 hai.',
      'req-2',
    );
    expect(full).toEqual({
      text: 'OTP 4321 hai.',
      voice: 'sahil',
      format: 'pcm16',
      request_id: 'req-2',
      style: 'excited',
      digits: 'mixed',
      speed: 1.2,
      temperature: 0.5,
      seed: 42,
      postfx: false,
      profile: 'telephony',
      raw: true,
    });
    expect(full).not.toHaveProperty('model');

    const defaults = _toVartalaapBody({ ...TEST_TTS_OPTIONS, profile: 'default' }, 'hi.', 'req-3');
    expect(defaults).not.toHaveProperty('profile');
    expect(defaults).not.toHaveProperty('style');
    expect(defaults).not.toHaveProperty('raw');
  });
});

describe('Vartalaap streaming pool', () => {
  it('sends each sentence as its own utterance, in order, and drops stale leftovers', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveVartalaap(wss, {
      onConnection: (ws) => {
        // What an interrupted previous turn left on a pooled socket.
        ws.send(JSON.stringify({ type: 'start', request_id: 'stale-request-id' }));
        ws.send(STALE_CHUNK, { binary: true });
        ws.send(JSON.stringify({ type: 'end', request_id: 'stale-request-id' }));
      },
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      const events = await synthesizeTurn(vartalaap, [
        'Pehla vaakya yahan khatam hota hai. ',
        'Doosra vaakya bhi yahan khatam hota hai.',
      ]);

      expect(server.utterances).toHaveLength(2);
      expect(server.utterances[0]!.text).toBe('Pehla vaakya yahan khatam hota hai.');
      expect(server.utterances[1]!.text).toBe('Doosra vaakya bhi yahan khatam hota hai.');
      expect(server.utterances[0]!.request_id).not.toBe(server.utterances[1]!.request_id);
      expect(server.utterances.every((u) => !('model' in u))).toBe(true);

      const audio = audioOf(events);
      expect(audio).toHaveLength(4 * FRAME_BYTES);
      expect(audio.subarray(0, 2 * FRAME_BYTES).equals(Buffer.alloc(2 * FRAME_BYTES, 1))).toBe(
        true,
      );
      expect(audio.subarray(2 * FRAME_BYTES).equals(Buffer.alloc(2 * FRAME_BYTES, 2))).toBe(true);
      expect(audio.includes(STALE_CHUNK)).toBe(false);
      expect(events.at(-1)!.final).toBe(true);
      expect(events.slice(0, -1).every((event) => !event.final)).toBe(true);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('rejects with a retryable APIStatusError when the server is busy (503)', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    serveVartalaap(wss, {
      onUtterance: (ws, utterance) => {
        ws.send(
          JSON.stringify({
            type: 'error',
            request_id: utterance.request_id,
            error: 'all workers busy',
            status: 503,
            retry_after: 2,
          }),
        );
        return false;
      },
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    const errorEvent = once(vartalaap, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;
    try {
      const events = await synthesizeTurn(vartalaap, ['busy turn.'], {
        ...DEFAULT_API_CONNECT_OPTIONS,
        maxRetry: 0,
      });
      expect(events).toHaveLength(0);

      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(503);
      expect((error as APIStatusError).retryable).toBe(true);
      expect(error.message).toContain('retry after 2s');
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('rejects with a non-retryable APIStatusError on a 400', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    serveVartalaap(wss, {
      onUtterance: (ws, utterance) => {
        ws.send(
          JSON.stringify({
            type: 'error',
            request_id: utterance.request_id,
            error: 'unknown style',
            status: 400,
          }),
        );
        return false;
      },
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    const errorEvent = once(vartalaap, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;
    try {
      expect(await synthesizeTurn(vartalaap, ['bad turn.'])).toHaveLength(0);

      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(400);
      expect((error as APIStatusError).retryable).toBe(false);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('applies updateOptions to the next utterance without reconnecting', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveVartalaap(wss);

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      expect(await synthesizeTurn(vartalaap, ['first turn.'])).not.toHaveLength(0);
      expect(server.utterances[0]).toMatchObject({ voice: 'saanvi' });
      expect(server.utterances[0]).not.toHaveProperty('style');

      vartalaap.updateOptions({ voice: 'sahil', expression: 'excited' });
      expect(await synthesizeTurn(vartalaap, ['second turn.'])).not.toHaveLength(0);
      expect(server.utterances[1]).toMatchObject({ voice: 'sahil', style: 'excited' });
      expect(server.connectionCount()).toBe(1);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('prewarms and reuses the ready websocket', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveVartalaap(wss);
    const connected = once(wss, 'connection');

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      vartalaap.prewarm();
      await connected;
      expect(await synthesizeTurn(vartalaap, ['prewarmed turn.'])).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(1);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('discards the socket when it drops mid-utterance and reconnects for the next turn', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveVartalaap(wss, {
      onUtterance: (ws, utterance, connectionNumber) => {
        if (connectionNumber === 1) {
          ws.send(JSON.stringify({ type: 'start', request_id: utterance.request_id }));
          ws.send(Buffer.alloc(FRAME_BYTES, 1), { binary: true });
          setTimeout(() => ws.close(1011, 'mid-speech drop'), 5);
          return false;
        }
        return true;
      },
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      expect(
        await synthesizeTurn(vartalaap, ['dropping turn.'], {
          ...DEFAULT_API_CONNECT_OPTIONS,
          maxRetry: 0,
        }),
      ).toHaveLength(0);
      expect(await synthesizeTurn(vartalaap, ['recovery turn.'])).not.toHaveLength(0);
      expect(server.connectionCount()).toBe(2);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });
});

describe('Vartalaap options', () => {
  it('requires an API key', () => {
    const saved = process.env.VARTALAAP_API_KEY;
    delete process.env.VARTALAAP_API_KEY;
    try {
      expect(() => new TTS()).toThrow(/VARTALAAP_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.VARTALAAP_API_KEY = saved;
    }
  });

  it('accepts only 24 kHz output', () => {
    expect(() => new TTS({ apiKey: 'test-key', sampleRate: 16000 })).toThrow(/24000/);
  });

  it('validates speed, temperature, digits and profile', () => {
    expect(() => new TTS({ apiKey: 'test-key', speed: 0.2 })).toThrow(/speed/);
    expect(() => new TTS({ apiKey: 'test-key', temperature: 3 })).toThrow(/temperature/);
    expect(() => new TTS({ apiKey: 'test-key', digits: 'fr' })).toThrow(/digits/);
    expect(() => new TTS({ apiKey: 'test-key', profile: 'studio' })).toThrow(/profile/);
    const vartalaap = new TTS({ apiKey: 'test-key' });
    expect(() => vartalaap.updateOptions({ speed: 2.5 })).toThrow(/speed/);
  });
});

describe('Vartalaap chunked synthesis', () => {
  async function startHttpServer(
    handler: (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => void,
  ) {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () =>
        handler(req, JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, res),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    return {
      baseURL: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  async function collect(stream: tts.ChunkedStream): Promise<tts.SynthesizedAudio[]> {
    const events: tts.SynthesizedAudio[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it('posts one utterance and forwards the chunked PCM body as it arrives', async () => {
    let seen: { url?: string; auth?: string; agent?: string; body?: Record<string, unknown> } = {};
    const http = await startHttpServer((req, body, res) => {
      seen = {
        url: req.url,
        auth: req.headers.authorization,
        agent: req.headers['user-agent'],
        body,
      };
      res.writeHead(200, {
        'content-type': 'audio/pcm;rate=24000;channels=1;encoding=signed-integer;bits=16',
        'x-request-id': String(body.request_id),
      });
      res.write(Buffer.alloc(FRAME_BYTES, 3));
      setTimeout(() => res.end(Buffer.alloc(FRAME_BYTES, 4)), 5);
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: http.baseURL, voice: 'meera' });
    try {
      const events = await collect(vartalaap.synthesize('Namaste duniya.'));
      expect(seen.url).toBe('/v1/tts');
      expect(seen.auth).toBe('Bearer test-key');
      expect(seen.agent).toMatch(/^agents-plugin-vartalaap\//);
      expect(seen.body).toMatchObject({
        text: 'Namaste duniya.',
        voice: 'meera',
        format: 'pcm16',
        digits: 'auto',
        stream: true,
      });
      expect(seen.body).not.toHaveProperty('model');
      const audio = audioOf(events);
      expect(audio).toHaveLength(2 * FRAME_BYTES);
      expect(audio.subarray(0, FRAME_BYTES).equals(Buffer.alloc(FRAME_BYTES, 3))).toBe(true);
      expect(audio.subarray(FRAME_BYTES).equals(Buffer.alloc(FRAME_BYTES, 4))).toBe(true);
    } finally {
      await vartalaap.close();
      await http.close();
    }
  });

  it('rejects a truncated body with a retryable APIConnectionError', async () => {
    const http = await startHttpServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'audio/pcm;rate=24000;channels=1' });
      res.write(Buffer.alloc(FRAME_BYTES, 5));
      // The connection drops mid-body, before the chunked encoding's terminator.
      setTimeout(() => res.destroy(), 5);
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: http.baseURL });
    const errorEvent = once(vartalaap, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;
    try {
      await collect(
        vartalaap.synthesize('cut off.', { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 }),
      );
      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIConnectionError);
      expect((error as APIConnectionError).retryable).toBe(true);
    } finally {
      await vartalaap.close();
      await http.close();
    }
  });

  it('turns a non-200 response into an APIStatusError with the status', async () => {
    const http = await startHttpServer((_req, _body, res) => {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end(JSON.stringify({ error: 'all workers busy' }));
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: http.baseURL });
    const errorEvent = once(vartalaap, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;
    try {
      const events = await collect(
        vartalaap.synthesize('busy.', { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 }),
      );
      expect(events).toHaveLength(0);
      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(503);
      expect((error as APIStatusError).retryable).toBe(true);
      expect(error.message).toContain('all workers busy (retry after 3s)');
    } finally {
      await vartalaap.close();
      await http.close();
    }
  });
});

describe('Vartalaap streaming recovery', () => {
  it('does not retry a 503 once the first sentence was heard: the error is final', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    // The first sentence is served; the server is busy for the second.
    const server = serveVartalaap(wss, {
      onUtterance: (ws, utterance) => {
        if (server.utterances.length === 2) {
          ws.send(
            JSON.stringify({
              type: 'error',
              request_id: utterance.request_id,
              error: 'all workers busy',
              status: 503,
              retry_after: 1,
            }),
          );
          return false;
        }
        return true;
      },
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    const errorEvent = once(vartalaap, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;
    try {
      const events = await synthesizeTurn(
        vartalaap,
        ['Pehla vaakya yahan khatam hota hai. ', 'Doosra vaakya bhi yahan khatam hota hai.'],
        { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 3, retryIntervalMs: 0 },
      );

      // The first sentence was heard once, in full; no retry re-sent it.
      expect(audioOf(events).equals(Buffer.alloc(2 * FRAME_BYTES, 1))).toBe(true);
      expect(server.connectionCount()).toBe(1);
      expect(server.utterances).toHaveLength(2);

      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(503);
      expect((error as APIStatusError).retryable).toBe(false);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('times out a server that goes silent after an utterance was sent', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    serveVartalaap(wss, { onUtterance: () => false });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL, chunkTimeout: 100 });
    const errorEvent = once(vartalaap, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;
    try {
      expect(
        await synthesizeTurn(vartalaap, ['silent turn.'], {
          ...DEFAULT_API_CONNECT_OPTIONS,
          maxRetry: 0,
        }),
      ).toHaveLength(0);
      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APITimeoutError);
      // The stuck socket was discarded, not pooled; give the close frame a beat to land.
      await waitFor(
        (async () => {
          while (wss.clients.size > 0) await new Promise((r) => setTimeout(r, 5));
        })(),
      );
      expect(wss.clients.size).toBe(0);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('applies updateOptions to the next utterance of a stream already running', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let firstUtteranceSeen: (() => void) | undefined;
    const firstUtterance = new Promise<void>((resolve) => {
      firstUtteranceSeen = resolve;
    });
    const server = serveVartalaap(wss, {
      onUtterance: () => {
        firstUtteranceSeen?.();
        return true;
      },
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      const stream = vartalaap.stream();
      stream.pushText('Pehla vaakya yahan khatam hota hai. ');
      stream.flush();
      await firstUtterance;
      vartalaap.updateOptions({ voice: 'sahil', expression: 'sad' });
      stream.pushText('Doosra vaakya bhi yahan khatam hota hai.');
      stream.endInput();

      const events: tts.SynthesizedAudio[] = [];
      for await (const event of stream) {
        if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
      }
      stream.close();

      expect(events).not.toHaveLength(0);
      expect(server.utterances).toHaveLength(2);
      expect(server.utterances[0]).toMatchObject({ voice: 'saanvi' });
      expect(server.utterances[0]).not.toHaveProperty('style');
      expect(server.utterances[1]).toMatchObject({ voice: 'sahil', style: 'sad' });
      expect(server.connectionCount()).toBe(1);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('ignores an error event of an utterance that is not ours', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    serveVartalaap(wss, {
      onUtterance: (ws) => {
        ws.send(
          JSON.stringify({
            type: 'error',
            request_id: 'old',
            error: 'engine timeout',
            status: 500,
          }),
        );
        return true;
      },
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    let errored = false;
    vartalaap.on('error', () => {
      errored = true;
    });
    try {
      const events = await synthesizeTurn(vartalaap, ['current turn.'], {
        ...DEFAULT_API_CONNECT_OPTIONS,
        maxRetry: 0,
      });
      expect(audioOf(events)).toHaveLength(2 * FRAME_BYTES);
      expect(errored).toBe(false);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });
});

describe('Vartalaap partial audio', () => {
  // The byte stream frames audio in 100 ms (4800 B) frames and holds the latest one back until
  // the next arrives, so three 80 ms server frames put exactly one frame on the queue.
  const THREE_SERVER_FRAMES = 3;

  it('does not retry once audio was heard: a drop mid-utterance is final, with no repeat', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveVartalaap(wss, {
      onUtterance: (ws, utterance) => {
        ws.send(JSON.stringify({ type: 'start', request_id: utterance.request_id }));
        for (let i = 0; i < THREE_SERVER_FRAMES; i++) {
          ws.send(Buffer.alloc(FRAME_BYTES, 1), { binary: true });
        }
        setTimeout(() => ws.close(1011, 'mid-speech drop'), 5);
        return false;
      },
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    const errorEvent = once(vartalaap, 'error') as Promise<Parameters<tts.TTSCallbacks['error']>>;
    try {
      // Retries are allowed, yet none happens: the audio already heard must not be repeated.
      const events = await synthesizeTurn(vartalaap, ['dropping turn.'], {
        ...DEFAULT_API_CONNECT_OPTIONS,
        maxRetry: 3,
        retryIntervalMs: 0,
      });
      expect(events).toHaveLength(1);
      expect(audioOf(events)).toHaveLength(4800);

      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIConnectionError);
      expect((error as APIConnectionError).retryable).toBe(false);
      expect(server.connectionCount()).toBe(1);
      expect(server.utterances).toHaveLength(1);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('closes each segment with a final frame under its own segment id', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    serveVartalaap(wss);

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      const stream = vartalaap.stream();
      stream.pushText('Pehla vaakya yahan khatam hota hai. ');
      stream.flush();
      stream.pushText('Doosra vaakya bhi yahan khatam hota hai.');
      stream.endInput();

      const events: tts.SynthesizedAudio[] = [];
      for await (const event of stream) {
        if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
      }
      stream.close();

      const segments = [...new Set(events.map((event) => event.segmentId))];
      expect(segments).toHaveLength(2);
      const [first, second] = segments as [string, string];
      const firstEvents = events.filter((event) => event.segmentId === first);
      const secondEvents = events.filter((event) => event.segmentId === second);
      expect(audioOf(firstEvents).equals(Buffer.alloc(2 * FRAME_BYTES, 1))).toBe(true);
      expect(audioOf(secondEvents).equals(Buffer.alloc(2 * FRAME_BYTES, 2))).toBe(true);
      expect(firstEvents.at(-1)!.final).toBe(true);
      expect(firstEvents.slice(0, -1).every((event) => !event.final)).toBe(true);
      expect(secondEvents.at(-1)!.final).toBe(true);
      expect(secondEvents.slice(0, -1).every((event) => !event.final)).toBe(true);
      // The first segment is closed before the second one opens.
      expect(events.indexOf(firstEvents.at(-1)!)).toBeLessThan(events.indexOf(secondEvents[0]!));
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });

  it('keeps the segment id when a 503 before any audio is retried on a new socket', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const server = serveVartalaap(wss, {
      onUtterance: (ws, utterance, connectionNumber) => {
        if (connectionNumber === 1) {
          ws.send(
            JSON.stringify({
              type: 'error',
              request_id: utterance.request_id,
              error: 'all workers busy',
              status: 503,
              retry_after: 1,
            }),
          );
          return false;
        }
        return true;
      },
    });

    const vartalaap = new TTS({ apiKey: 'test-key', baseUrl: baseURL });
    try {
      const stream = vartalaap.stream({
        connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 1, retryIntervalMs: 0 },
      });
      stream.pushText('Pehla vaakya yahan khatam hota hai. ');
      stream.flush();
      stream.pushText('Doosra vaakya bhi yahan khatam hota hai.');
      stream.endInput();

      const events: tts.SynthesizedAudio[] = [];
      for await (const event of stream) {
        if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
      }
      stream.close();

      expect(server.connectionCount()).toBe(2);
      // Both sentences on the first socket (the second one was queued behind the busy first),
      // then both again on the second: the retry starts over because nothing was heard.
      expect(server.utterances.map((u) => u.text)).toEqual([
        'Pehla vaakya yahan khatam hota hai.',
        'Doosra vaakya bhi yahan khatam hota hai.',
        'Pehla vaakya yahan khatam hota hai.',
        'Doosra vaakya bhi yahan khatam hota hai.',
      ]);

      // Audio once, from the retry (utterances 3 and 4), in two segments with stable ids:
      // the same two ids the first attempt reported, so the user-facing segment sequence is
      // unaffected by the retry.
      const audio = audioOf(events);
      expect(audio).toHaveLength(4 * FRAME_BYTES);
      expect(audio.subarray(0, 2 * FRAME_BYTES).equals(Buffer.alloc(2 * FRAME_BYTES, 3))).toBe(
        true,
      );
      expect(audio.subarray(2 * FRAME_BYTES).equals(Buffer.alloc(2 * FRAME_BYTES, 4))).toBe(true);
      const segments = [...new Set(events.map((event) => event.segmentId))];
      expect(segments).toHaveLength(2);
      expect(events.filter((e) => e.final)).toHaveLength(2);
    } finally {
      await vartalaap.close();
      await closeWebSocketServer(wss);
    }
  });
});
