// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, tts as agentsTts, initializeLogger } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { BULBUL_V4_FLASH_SPEAKERS, MODEL_SPEAKER_COMPATIBILITY } from './models.js';
import { TTS, extractErrorStatusCode } from './tts.js';

const hasSarvamApiKey = Boolean(process.env.SARVAM_API_KEY);

afterEach(() => {
  vi.restoreAllMocks();
});

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected websocket server to listen on a TCP port');
  }
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function speak(sarvam: TTS): Promise<void> {
  const stream = sarvam.stream();
  stream.pushText('Namaste.');
  stream.endInput();
  try {
    for await (const _event of stream) {
      // Drain the stream so its background task and errors complete.
    }
    if (stream.error) throw stream.error;
  } finally {
    stream.close();
  }
}

function completeOnFlush(socket: WebSocket, configs: Record<string, unknown>[]): void {
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as {
      type: string;
      data?: Record<string, unknown>;
    };
    if (message.type === 'config' && message.data) configs.push(message.data);
    if (message.type === 'flush') {
      socket.send(JSON.stringify({ type: 'event', data: { event_type: 'final' } }));
    }
  });
}

describe('Sarvam TTS', () => {
  it.skipIf(!hasSarvamApiKey)('runs integration suite with real API key', async () => {
    await tts(new TTS({ apiKey: process.env.SARVAM_API_KEY }), new STT(), { streaming: false });
  });

  it('supports opting into non-streaming mode', () => {
    const nonStreamingTts = new TTS({ apiKey: 'dummy-api-key', streaming: false });

    expect(nonStreamingTts.capabilities.streaming).toBe(false);
    expect(() => nonStreamingTts.stream()).toThrow(/streaming is disabled/i);
  });

  it('uses the v4-flash speaker catalogue and rejects the bulbul:v4 alias', () => {
    expect(BULBUL_V4_FLASH_SPEAKERS).toContain('ritu_hi_medical');
    expect(MODEL_SPEAKER_COMPATIBILITY['bulbul:v4-flash']).not.toContain('shubh');
    expect(MODEL_SPEAKER_COMPATIBILITY).not.toHaveProperty('bulbul:v4');

    expect(() => new TTS({ apiKey: 'test', model: 'bulbul:v4-flash', speaker: 'shubh' })).toThrow(
      /not compatible/,
    );
  });

  it('validates v4-flash parameter bounds while retaining wider v3 bounds', () => {
    expect(
      () => new TTS({ apiKey: 'test', model: 'bulbul:v4-flash', loudness: 2.5 }),
    ).not.toThrow();
    expect(() => new TTS({ apiKey: 'test', model: 'bulbul:v4-flash', loudness: 3 })).toThrow(
      /loudness/,
    );
    expect(() => new TTS({ apiKey: 'test', model: 'bulbul:v4-flash', pace: 0.3 })).toThrow(/pace/);
    expect(() => new TTS({ apiKey: 'test', model: 'bulbul:v4-flash', temperature: 1.5 })).toThrow(
      /temperature/,
    );
    expect(() => new TTS({ apiKey: 'test', model: 'bulbul:v3', pace: 0.3 })).not.toThrow();
  });

  it('commits option updates atomically and revalidates retained values', () => {
    const sarvam = new TTS({ apiKey: 'test', model: 'bulbul:v3', pace: 0.3, temperature: 1.5 });

    expect(() => sarvam.updateOptions({ model: 'bulbul:v4-flash' })).toThrow(/not compatible/);
    expect(() =>
      sarvam.updateOptions({ model: 'bulbul:v4-flash', speaker: 'ritu_hi_medical' }),
    ).toThrow(/pace/);

    sarvam.updateOptions({ pace: 1, temperature: 0.6 });
    sarvam.updateOptions({ model: 'bulbul:v4-flash', speaker: 'ritu_hi_medical' });
    expect(() => sarvam.updateOptions({ loudness: 2.5 })).not.toThrow();
  });

  it('sends v4-flash REST fields without v2-only response caching', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ audios: [Buffer.alloc(960).toString('base64')] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const sarvam = new TTS({
      apiKey: 'test',
      model: 'bulbul:v4-flash',
      dictId: 'dict-1',
      pitch: 0.7,
      speaker: 'ritu_hi_medical',
    });

    await sarvam.synthesize('hello').collect();

    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'bulbul:v4-flash',
      pitch: 0.5,
      loudness: 1,
      enable_preprocessing: false,
      temperature: 0.6,
      dict_id: 'dict-1',
    });
    expect(body).not.toHaveProperty('enable_cached_responses');
  });

  it('keeps v3 REST request fields unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ audios: [Buffer.alloc(960).toString('base64')] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const sarvam = new TTS({ apiKey: 'test', model: 'bulbul:v3', dictId: 'dict-1' });

    await sarvam.synthesize('hello').collect();

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'bulbul:v3', temperature: 0.6, dict_id: 'dict-1' });
    expect(body).not.toHaveProperty('pitch');
    expect(body).not.toHaveProperty('loudness');
    expect(body).not.toHaveProperty('enable_preprocessing');
  });

  it('pins v4-flash to /ws/v2 with its default speaker and config fields', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const requests: string[] = [];
    const configs: Record<string, unknown>[] = [];
    wss.on('connection', (socket, request) => {
      requests.push(request.url ?? '');
      completeOnFlush(socket, configs);
    });

    try {
      await speak(new TTS({ apiKey: 'test', baseURL, model: 'bulbul:v4-flash' }));
      expect(requests).toEqual([
        '/text-to-speech/ws/v2?model=bulbul%3Av4-flash&send_completion_event=true',
      ]);
      expect(configs[0]).toMatchObject({
        model: 'bulbul:v4-flash',
        speaker: 'shubh_en_narration_gentle',
        temperature: 0.6,
        output_audio_bitrate: '128k',
        min_buffer_size: 50,
        max_chunk_length: 150,
      });
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('keeps v3 on the original websocket endpoint', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const requests: string[] = [];
    wss.on('connection', (socket, request) => {
      requests.push(request.url ?? '');
      completeOnFlush(socket, []);
    });

    try {
      await speak(new TTS({ apiKey: 'test', baseURL, model: 'bulbul:v3' }));
      expect(requests[0]?.startsWith('/text-to-speech/ws?model=bulbul%3Av3&')).toBe(true);
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('rejects unsupported v4-flash streaming sample rates', async () => {
    const sarvam = new TTS({
      apiKey: 'test',
      model: 'bulbul:v4-flash',
      sampleRate: 48000,
    });
    await expect(speak(sarvam)).rejects.toThrow(/sampleRate/);
  });

  it('adopts updated model options when a pending stream starts', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const configs: Record<string, unknown>[] = [];
    wss.on('connection', (socket) => completeOnFlush(socket, configs));
    const sarvam = new TTS({ apiKey: 'test', baseURL, model: 'bulbul:v3' });
    const stream = sarvam.stream();
    sarvam.updateOptions({ model: 'bulbul:v4-flash', speaker: 'ritu_hi_medical' });
    stream.pushText('Namaste.');
    stream.endInput();

    try {
      for await (const event of stream) {
        if (event === agentsTts.SynthesizeStream.END_OF_STREAM) continue;
      }
      expect(configs[0]).toMatchObject({
        model: 'bulbul:v4-flash',
        speaker: 'ritu_hi_medical',
      });
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it.each([
    [{ code: 422, message: 'bad input' }, 422, false],
    [{ code: '400', message: 'invalid speaker' }, 400, false],
    [{ message: '400: incompatible speaker' }, 400, false],
  ] as const)(
    'maps websocket error %# to API status retryability',
    async (frame, code, retryable) => {
      const { wss, baseURL } = await startWebSocketServer();
      wss.on('connection', (socket) => {
        socket.once('message', () => socket.send(JSON.stringify({ type: 'error', data: frame })));
      });

      try {
        const error = await speak(
          new TTS({ apiKey: 'test', baseURL, model: 'bulbul:v4-flash' }),
        ).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(APIStatusError);
        expect(error).toMatchObject({ statusCode: code, retryable });
        expect(String(error)).not.toContain(frame.message);
      } finally {
        await closeWebSocketServer(wss);
      }
    },
  );

  it('forwards websocket request IDs without putting provider text on the exception', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const message = 'my card number is 4111 1111 1111 1111';
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    initializeLogger({ pretty: false, level: 'error' });
    wss.on('connection', (socket) => {
      socket.once('message', () =>
        socket.send(
          JSON.stringify({
            type: 'error',
            data: { request_id: '20260918_abc', code: 422, message },
          }),
        ),
      );
    });

    try {
      const error = await speak(
        new TTS({ apiKey: 'test', baseURL, model: 'bulbul:v4-flash' }),
      ).catch((error: unknown) => error);
      expect(error).toMatchObject({ requestId: '20260918_abc', statusCode: 422 });
      expect(String(error)).not.toContain(message);
      const record = writes
        .flatMap((write) => write.trim().split('\n'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.msg === 'TTS API error');
      expect(record?.msg).not.toContain(message);
      expect(record?.['lk.pii.error_message']).toContain(message);
      expect(record?.['lk.pii.raw_message']).toMatchObject({
        type: 'error',
        data: { message },
      });
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it.each([
    [{ code: 429, message: 'rate limit exceeded' }, 429, true],
    [{ code: 503, message: 'model unavailable' }, 503, true],
    [{ message: 'something we cannot classify' }, -1, true],
    [{ code: 'invalid_request_error', message: 'bad input' }, -1, true],
  ] as const)(
    'keeps transient and unrecognized error frame %# retryable',
    (frame, code, retryable) => {
      const statusCode = extractErrorStatusCode(frame);
      const error = new APIStatusError({ message: 'Sarvam error', options: { statusCode } });
      expect(error).toMatchObject({ statusCode: code, retryable });
    },
  );
});
