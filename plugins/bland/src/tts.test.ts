// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
} from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTTS } from '@livekit/agents-plugins-test';
import type { AudioFrame } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChunkedStream, TTS } from './tts.js';

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

  it('reports its provider and non-streaming capability', () => {
    const instance = new TTS({ apiKey: 'test-key' });
    expect(instance.provider).toBe('Bland');
    expect(instance.capabilities.streaming).toBe(false);
  });

  it('uses the default and custom voice IDs', async () => {
    const defaultRequest = await capturedRequest(new TTS({ apiKey: 'test-key' }));
    expect(defaultRequest.body.voice).toBe('f04af0e5-1a80-48a9-b02d-52f30d417cfa');

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
      voice: 'f04af0e5-1a80-48a9-b02d-52f30d417cfa',
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

  it('sends the default request body without undefined fields', async () => {
    const { body } = await capturedRequest(new TTS({ apiKey: 'test-key' }));
    expect(body).toEqual({
      text: 'hello world',
      voice: 'f04af0e5-1a80-48a9-b02d-52f30d417cfa',
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

const hasBlandConfig = Boolean(process.env.BLAND_API_KEY && process.env.OPENAI_API_KEY);
if (hasBlandConfig) {
  describe('Bland TTS integration', async () => {
    await testTTS(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('Bland TTS integration', () => {
    it.skip('requires BLAND_API_KEY and OPENAI_API_KEY', () => {});
  });
}
