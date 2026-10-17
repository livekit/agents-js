// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError, APIStatusError, APITimeoutError, tts } from '@livekit/agents';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTS, type TTSOptions } from './tts.js';
import { wavBytes, wavResponse } from './tts_test_utils.js';

const TTS_URL = 'https://tts.example.invalid/cognitiveservices/v1?deployment=dummy';
const VOICE = 'en-US-Dummy:test-synthesizer';
const PCM = new Uint8Array(3717 * 2).fill(0x81);
const CONNECTION_OPTIONS = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 500 };
const microsoftEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.startsWith('MICROSOFT_AI_')),
);
const openAIKey = process.env.OPENAI_API_KEY;

function provider(fetch: typeof globalThis.fetch, options: Partial<TTSOptions> = {}): TTS {
  const instance = new TTS({
    url: TTS_URL,
    model: 'test-synthesizer',
    voice: VOICE,
    sampleRate: 24000,
    apiKey: 'dummy-tts-key',
    fetch,
    ...options,
  });
  instance.on('error', () => {});
  return instance;
}

async function collect(instance: TTS, text = 'Hello.') {
  const stream = instance.synthesize(text, CONNECTION_OPTIONS);
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, error: stream.error };
}

function concatenate(events: Awaited<ReturnType<typeof collect>>['events']): Uint8Array {
  const length = events.reduce((total, event) => total + event.frame.data.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const event of events) {
    const bytes = new Uint8Array(
      event.frame.data.buffer,
      event.frame.data.byteOffset,
      event.frame.data.byteLength,
    );
    output.set(bytes, offset);
    offset += bytes.length;
  }
  return output;
}

function clearMicrosoftEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('MICROSOFT_AI_')) delete process.env[name];
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

beforeEach(clearMicrosoftEnvironment);

afterEach(() => {
  vi.restoreAllMocks();
  clearMicrosoftEnvironment();
  Object.assign(process.env, microsoftEnvironment);
  if (openAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = openAIKey;
});

describe('Microsoft AI TTS', () => {
  it('posts escaped SSML and emits exactly the complete validated PCM', async () => {
    const fetch = vi.fn(async () => wavResponse(PCM));
    const instance = provider(fetch as typeof globalThis.fetch);
    const text = '</voice><audio src="https://example.invalid/audio"/> & <voice>literal';
    const { events, error } = await collect(instance, text);

    expect(error).toBeUndefined();
    expect(concatenate(events)).toEqual(PCM);
    expect(events.every((event) => event.frame.sampleRate === 24000)).toBe(true);
    expect(events.every((event) => event.frame.channels === 1)).toBe(true);
    expect(events.filter((event) => event.final)).toHaveLength(1);
    expect(events.at(-1)?.final).toBe(true);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    expect(instance.capabilities.streaming).toBe(false);
    expect(instance.model).toBe('test-synthesizer');
    expect(instance.provider).toBe('Microsoft AI');

    const [requestUrl, init] = fetch.mock.calls[0]!;
    expect(requestUrl).toBe(TTS_URL);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('dummy-tts-key');
    expect(headers.Accept).toBe('audio/wav');
    expect(headers['Content-Type']).toBe('application/ssml+xml');
    expect(headers['X-Microsoft-OutputFormat']).toBe('riff-24khz-16bit-mono-pcm');
    const body = new TextDecoder().decode(init?.body as Uint8Array);
    expect(body).toContain('&lt;audio');
    expect(body).toContain('&amp;');
    expect(body).not.toContain('<audio');
    await instance.close();
  });

  it('posts the exact SSML document and XML-escapes the complete voice ID', async () => {
    const fetch = vi.fn(async () => wavResponse(PCM));
    const voice = 'en-US-Dummy" /><audio src="x"/>:test-synthesizer';
    const instance = provider(fetch as typeof globalThis.fetch, { voice });
    await collect(instance);

    const body = new TextDecoder().decode(fetch.mock.calls[0]![1]?.body as Uint8Array);
    expect(body).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-Dummy&quot; /&gt;&lt;audio src=&quot;x&quot;/&gt;:test-synthesizer">Hello.</voice></speak>',
    );
    expect(body.match(/<voice/g)).toHaveLength(1);
    expect(body).not.toContain('<audio');
    await instance.close();
  });

  it('uses constructor, process environment, then selected dotenv without interpolation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'microsoft-ai-'));
    const path = join(directory, 'endpoints.env');
    writeFileSync(
      path,
      [
        'MICROSOFT_AI_TTS_URL=https://file.example.invalid/speech',
        'MICROSOFT_AI_TTS_MODEL=file-model',
        'MICROSOFT_AI_TTS_VOICE=en-US-Dummy:file-model',
        'MICROSOFT_AI_TTS_SAMPLE_RATE=24000',
        "MICROSOFT_AI_TTS_API_KEY='${SHOULD_NOT_INTERPOLATE}'",
      ].join('\n'),
    );
    process.env.MICROSOFT_AI_TTS_MODEL = 'environment-model';
    process.env.MICROSOFT_AI_TTS_VOICE = 'en-US-Dummy:environment-model';
    const instance = new TTS({
      envFile: path,
      model: 'constructor-model',
      voice: 'x:constructor-model',
    });
    expect(instance.model).toBe('constructor-model');
    expect(process.env.MICROSOFT_AI_TTS_API_KEY).toBeUndefined();
    rmSync(directory, { recursive: true });
  });

  it('deliberately bypasses API-key lookup for explicit empty headers', async () => {
    process.env.MICROSOFT_AI_TTS_URL = TTS_URL;
    process.env.MICROSOFT_AI_TTS_MODEL = 'environment-model';
    process.env.MICROSOFT_AI_TTS_VOICE = 'en-US-Dummy:environment-model';
    process.env.MICROSOFT_AI_TTS_SAMPLE_RATE = '24000';
    process.env.MICROSOFT_AI_TTS_API_KEY = 'must-not-be-used';
    const fetch = vi.fn(async () => wavResponse(PCM));
    const instance = new TTS({ headers: {}, fetch: fetch as typeof globalThis.fetch });
    instance.on('error', () => {});
    await collect(instance);
    const headers = fetch.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers).toEqual({
      'User-Agent': 'LiveKit Agents',
      Accept: 'audio/wav',
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
    });
  });

  it.each([302, 400, 401, 403, 422, 429, 500, 503])(
    'maps HTTP %i without exposing response bodies',
    async (status) => {
      const instance = provider(
        vi.fn(async () => new Response('do-not-log-this-dummy-secret', { status })) as typeof fetch,
      );
      const { error } = await collect(instance);
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(status);
      expect((error as APIStatusError).retryable).toBe([429, 500, 503].includes(status));
      expect(String(error)).not.toContain('do-not-log');
    },
  );

  it('does not treat a remote 499 as local cancellation', async () => {
    const instance = provider(
      vi.fn(async () => new Response(null, { status: 499 })) as typeof fetch,
    );
    const { error } = await collect(instance);
    expect(error).toBeInstanceOf(APIError);
    expect(error).not.toBeInstanceOf(APIStatusError);
    expect(error?.message).toContain('499');
    expect((error as APIError).retryable).toBe(false);
  });

  it('retries rate limits without emitting stale audio', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(wavResponse(PCM));
    const instance = provider(fetch as typeof globalThis.fetch);
    const stream = instance.synthesize('Hello.', {
      maxRetry: 1,
      retryIntervalMs: 0,
      timeoutMs: 500,
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(stream.error).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(concatenate(events)).toEqual(PCM);
  });

  it('retries an interrupted body without emitting partial audio', async () => {
    const interrupted = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(wavBytes(PCM).slice(0, 200));
          controller.error(new Error('do-not-log-this-endpoint'));
        },
      }),
      { headers: { 'Content-Type': 'audio/wav' } },
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(wavResponse(PCM));
    const instance = provider(fetch as typeof globalThis.fetch);
    const stream = instance.synthesize('Hello.', {
      maxRetry: 1,
      retryIntervalMs: 0,
      timeoutMs: 500,
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(stream.error).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(concatenate(events)).toEqual(PCM);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
  });

  it.each([
    ['not a WAV', new TextEncoder().encode('not a WAV')],
    ['empty', wavBytes(new Uint8Array())],
    ['truncated', wavBytes(PCM).slice(0, -3)],
    ['wrong rate', wavBytes(PCM, { sampleRate: 16000 })],
    ['stereo', wavBytes(PCM, { channels: 2 })],
    ['8-bit', wavBytes(PCM, { bitsPerSample: 8 })],
  ])('rejects %s audio before emission', async (_name, body) => {
    const instance = provider(
      vi.fn(
        async () => new Response(body, { headers: { 'Content-Type': 'audio/wav' } }),
      ) as typeof fetch,
    );
    const { events, error } = await collect(instance);
    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).retryable).toBe(false);
  });

  it.each(['application/json', 'audio/pcm', 'text/event-stream', 'audio/mpeg'])(
    'rejects unconfirmed response type %s',
    async (contentType) => {
      const instance = provider(
        vi.fn(async () => wavResponse(PCM, { contentType })) as typeof fetch,
      );
      const { error } = await collect(instance);
      expect(error?.message).toContain('WAV response');
      expect((error as APIError).retryable).toBe(false);
    },
  );

  it('bounds both declared and streamed response sizes', async () => {
    for (const contentLength of [undefined, 1_000_000]) {
      const instance = provider(
        vi.fn(async () => wavResponse(PCM, { contentLength })) as typeof fetch,
        { maxAudioBytes: 128 },
      );
      const { events, error } = await collect(instance);
      expect(events).toEqual([]);
      expect(error?.message).toContain('maxAudioBytes');
    }
  });

  it('translates a request deadline without leaking transport details', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const instance = provider(fetch as typeof globalThis.fetch, { requestTimeout: 5 });
    const { error } = await collect(instance);
    expect(error).toBeInstanceOf(APITimeoutError);
    expect(error?.message).not.toContain(TTS_URL);
  });

  it('times out during body reads, cancels the reader, and emits no partial audio', async () => {
    let cancelled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(wavBytes(PCM).slice(0, 200));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'audio/wav' } },
        ),
    );
    const instance = provider(fetch as typeof globalThis.fetch, { requestTimeout: 5 });
    const { events, error } = await collect(instance);
    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(APITimeoutError);
    expect(cancelled).toBe(true);
  });

  it('cancels in-flight HTTP and emits no late audio', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          markStarted();
        },
      }),
      { headers: { 'Content-Type': 'audio/wav' } },
    );
    const instance = provider(vi.fn(async () => response) as typeof fetch);
    const stream = instance.synthesize('Hello.', CONNECTION_OPTIONS);
    await started;
    stream.close();
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([]);
  });

  it('cancels the response reader when a stream is closed', async () => {
    let started = false;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          started = true;
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'audio/wav' } },
    );
    const instance = provider(vi.fn(async () => response) as typeof fetch);
    const stream = instance.synthesize('Hello.', CONNECTION_OPTIONS);
    await waitUntil(() => started);
    stream.close();
    await waitUntil(() => cancelled);
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    await instance.close();
  });

  it('discards audio already buffered when the stream is closed', async () => {
    const instance = provider(vi.fn(async () => wavResponse(PCM)) as typeof fetch);
    const stream = instance.synthesize('Hello.', CONNECTION_OPTIONS);
    expect((await stream.next()).done).toBe(false);
    stream.close();
    const remaining = [];
    for await (const event of stream) remaining.push(event);
    expect(remaining).toEqual([]);
    await instance.close();
  });

  it('provider close cancels every active request and rejects future synthesis', async () => {
    const started = [false, false];
    const cancelled = [false, false];
    const fetch = vi.fn(async () => {
      const index = fetch.mock.calls.length - 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            started[index] = true;
          },
          cancel() {
            cancelled[index] = true;
          },
        }),
        { headers: { 'Content-Type': 'audio/wav' } },
      );
    });
    const instance = provider(fetch as typeof globalThis.fetch);
    const streams = [
      instance.synthesize('First.', CONNECTION_OPTIONS),
      instance.synthesize('Second.', CONNECTION_OPTIONS),
    ];
    await waitUntil(() => started.every(Boolean));
    await instance.close();
    await waitUntil(() => cancelled.every(Boolean));
    for (const stream of streams)
      expect(await stream.next()).toEqual({ done: true, value: undefined });
    expect(() => instance.synthesize('Future.')).toThrow(/closed/);
  });

  it('forgets failed streams instead of closing them again with the provider', async () => {
    const instance = provider(
      vi.fn(async () => new Response(null, { status: 400 })) as typeof fetch,
    );
    const stream = instance.synthesize('Hello.', CONNECTION_OPTIONS);
    for await (const _event of stream) {
      // no audio is emitted for a failed request
    }
    expect(stream.error).toBeInstanceOf(APIStatusError);
    const close = vi.spyOn(stream, 'close');
    await instance.close();
    expect(close).not.toHaveBeenCalled();
  });

  it('cancels rejected response bodies where Fetch exposes cleanup', async () => {
    let cancelled = false;
    const instance = provider(
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status: 429 },
          ),
      ) as typeof fetch,
    );
    await collect(instance);
    await waitUntil(() => cancelled);
    await instance.close();
  });

  it('works through the sentence StreamAdapter using its current stream API', async () => {
    const fetch = vi.fn(async () => wavResponse(PCM));
    const instance = provider(fetch as typeof globalThis.fetch);
    const adapter = new tts.StreamAdapter(instance);
    const stream = adapter.stream({ connOptions: CONNECTION_OPTIONS });
    stream.updateInputStream(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue('The first sentence is long enough to tokenize on its own. ');
          controller.enqueue('The second sentence is also long enough to tokenize on its own.');
          controller.close();
        },
      }),
    );
    let frameCount = 0;
    for await (const event of stream) {
      if (event !== tts.SynthesizeStream.END_OF_STREAM) frameCount++;
    }
    expect(frameCount).toBeGreaterThan(0);
    expect(
      fetch.mock.calls.map((call) => new TextDecoder().decode(call[1]?.body as Uint8Array)),
    ).toEqual([
      expect.stringContaining('>The first sentence is long enough to tokenize on its own.</voice>'),
      expect.stringContaining(
        '>The second sentence is also long enough to tokenize on its own.</voice>',
      ),
    ]);
    expect(adapter.capabilities.streaming).toBe(true);
    expect(instance.capabilities.streaming).toBe(false);
    await adapter.close();
    await instance.close();
  });

  it.each([
    [8000, 'riff-8khz-16bit-mono-pcm'],
    [22050, 'riff-22050hz-16bit-mono-pcm'],
    [24000, 'riff-24khz-16bit-mono-pcm'],
    [44100, 'riff-44100hz-16bit-mono-pcm'],
    [48000, 'riff-48khz-16bit-mono-pcm'],
  ])('uses the documented %i Hz WAV output format', async (sampleRate, format) => {
    const fetch = vi.fn(async () => wavResponse(PCM, { sampleRate }));
    const instance = provider(fetch as typeof globalThis.fetch, { sampleRate });
    const { events } = await collect(instance);
    expect(
      (fetch.mock.calls[0]![1]?.headers as Record<string, string>)['X-Microsoft-OutputFormat'],
    ).toBe(format);
    expect(events.every((event) => event.frame.sampleRate === sampleRate)).toBe(true);
  });
});

describe('Microsoft AI TTS validation', () => {
  const basic = { model: 'test', voice: 'en-US-Dummy:test', sampleRate: 24000, headers: {} };

  it('has no guessed defaults and never uses OpenAI credentials', () => {
    process.env.OPENAI_API_KEY = 'not-for-microsoft-ai';
    expect(() => new TTS()).toThrow('MICROSOFT_AI_TTS_SAMPLE_RATE');
    expect(() => new TTS({ sampleRate: 24000 })).toThrow('MICROSOFT_AI_TTS_MODEL');
    expect(() => new TTS({ sampleRate: 24000, model: 'test' })).toThrow('MICROSOFT_AI_TTS_VOICE');
    expect(
      () =>
        new TTS({
          sampleRate: 24000,
          model: 'test',
          voice: 'en-US-Dummy:test',
          url: TTS_URL,
        }),
    ).toThrow('MICROSOFT_AI_TTS_API_KEY');
  });

  it.each([0, 500, 7999, 192001, true])('rejects unusable sample rate %s', (sampleRate) => {
    expect(() => new TTS({ ...basic, sampleRate: sampleRate as number, url: TTS_URL })).toThrow(
      /sampleRate/,
    );
  });

  it('uses URL and region precedence without rewriting configured URLs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'microsoft-ai-'));
    const path = join(directory, 'endpoints.env');
    writeFileSync(
      path,
      [
        'MICROSOFT_AI_TTS_URL=https://file.example.invalid/exact',
        'MICROSOFT_AI_TTS_REGION=file-region',
        'MICROSOFT_AI_TTS_MODEL=test',
        'MICROSOFT_AI_TTS_VOICE=en-US-Dummy:test',
        'MICROSOFT_AI_TTS_SAMPLE_RATE=24000',
      ].join('\n'),
    );
    process.env.MICROSOFT_AI_TTS_URL = 'https://environment.example.invalid/exact?q=dummy';
    process.env.MICROSOFT_AI_TTS_REGION = 'environment-region';
    const fetch = vi.fn(async () => wavResponse(PCM));
    const fromEnvironment = new TTS({ envFile: path, headers: {}, fetch });
    fromEnvironment.on('error', () => {});
    await collect(fromEnvironment);
    expect(fetch.mock.calls[0]![0]).toBe(process.env.MICROSOFT_AI_TTS_URL);

    const argumentUrl = 'https://argument.example.invalid/exact';
    const fromArgument = new TTS({
      envFile: path,
      url: argumentUrl,
      region: 'eastus2',
      headers: {},
      fetch,
    });
    fromArgument.on('error', () => {});
    await collect(fromArgument);
    expect(fetch.mock.calls[1]![0]).toBe(argumentUrl);

    delete process.env.MICROSOFT_AI_TTS_URL;
    delete process.env.MICROSOFT_AI_TTS_REGION;
    const fileUrlWinsRegion = new TTS({ envFile: path, region: 'eastus2', headers: {}, fetch });
    fileUrlWinsRegion.on('error', () => {});
    await collect(fileUrlWinsRegion);
    expect(fetch.mock.calls[2]![0]).toBe('https://file.example.invalid/exact');

    const regionPath = join(directory, 'region.env');
    writeFileSync(
      regionPath,
      [
        'MICROSOFT_AI_TTS_REGION=file-region',
        'MICROSOFT_AI_TTS_MODEL=test',
        'MICROSOFT_AI_TTS_VOICE=en-US-Dummy:test',
        'MICROSOFT_AI_TTS_SAMPLE_RATE=24000',
      ].join('\n'),
    );
    process.env.MICROSOFT_AI_TTS_REGION = 'environment-region';
    const regionFromEnvironment = new TTS({ envFile: regionPath, headers: {}, fetch });
    regionFromEnvironment.on('error', () => {});
    await collect(regionFromEnvironment);
    expect(fetch.mock.calls[3]![0]).toBe(
      'https://environment-region.tts.speech.microsoft.com/cognitiveservices/v1',
    );
    const regionFromArgument = new TTS({
      envFile: regionPath,
      region: 'eastus2',
      headers: {},
      fetch,
    });
    regionFromArgument.on('error', () => {});
    await collect(regionFromArgument);
    expect(fetch.mock.calls[4]![0]).toBe(
      'https://eastus2.tts.speech.microsoft.com/cognitiveservices/v1',
    );
    await fromEnvironment.close();
    await fromArgument.close();
    await fileUrlWinsRegion.close();
    await regionFromEnvironment.close();
    await regionFromArgument.close();
    rmSync(directory, { recursive: true });
  });

  it.each(['', ' \t '])(
    'rejects an explicitly present empty URL %j without region fallback',
    (url) => {
      expect(() => new TTS({ ...basic, url, region: 'eastus2' })).toThrow('MICROSOFT_AI_TTS_URL');
      process.env.MICROSOFT_AI_TTS_URL = url;
      expect(() => new TTS({ ...basic, region: 'eastus2' })).toThrow('MICROSOFT_AI_TTS_URL');
    },
  );

  it('rejects an empty dotenv URL but lets a nonempty higher-priority URL override it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'microsoft-ai-'));
    const path = join(directory, 'endpoints.env');
    writeFileSync(
      path,
      [
        'MICROSOFT_AI_TTS_URL=',
        'MICROSOFT_AI_TTS_REGION=eastus2',
        'MICROSOFT_AI_TTS_MODEL=test',
        'MICROSOFT_AI_TTS_VOICE=en-US-Dummy:test',
        'MICROSOFT_AI_TTS_SAMPLE_RATE=24000',
      ].join('\n'),
    );
    expect(() => new TTS({ envFile: path, headers: {} })).toThrow('MICROSOFT_AI_TTS_URL');

    process.env.MICROSOFT_AI_TTS_URL = 'https://environment.example.invalid/exact';
    expect(() => new TTS({ envFile: path, headers: {} })).not.toThrow();
    process.env.MICROSOFT_AI_TTS_URL = '';
    expect(
      () => new TTS({ envFile: path, url: 'https://argument.example.invalid/exact', headers: {} }),
    ).not.toThrow();
    rmSync(directory, { recursive: true });
  });

  it('reports missing and empty selected dotenv files without exposing their paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'microsoft-ai-secret-'));
    const missing = join(directory, 'do-not-log-missing.env');
    let error: unknown;
    try {
      new TTS({ envFile: missing });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('Could not read the selected Microsoft AI environment file');
    expect(String(error)).not.toContain(missing);

    const empty = join(directory, 'do-not-log-empty.env');
    writeFileSync(empty, 'MICROSOFT_AI_TTS_SAMPLE_RATE=\n');
    expect(() => new TTS({ envFile: empty })).toThrow('MICROSOFT_AI_TTS_SAMPLE_RATE');
    try {
      new TTS({ envFile: empty });
    } catch (caught) {
      expect(String(caught)).not.toContain(empty);
    }
    rmSync(directory, { recursive: true });
  });

  it.each([
    'http://remote.example.invalid/speech',
    'https://user:dummy@example.invalid/speech',
    'https://example.invalid/speech#fragment',
    'file:///speech',
  ])('rejects invalid or insecure URL %s', (url) =>
    expect(() => new TTS({ ...basic, url })).toThrow(),
  );

  it.each(['east us 2', 'eastus2.example.invalid/path', '../eastus2', ''])(
    'rejects invalid region %s',
    (region) => expect(() => new TTS({ ...basic, region })).toThrow(),
  );

  it.each(['eastus2', 'EastUS2'])('constructs the regional endpoint for %s', async (region) => {
    const fetch = vi.fn(async () => wavResponse(PCM));
    const instance = new TTS({
      ...basic,
      region,
      apiKey: undefined,
      fetch: fetch as typeof globalThis.fetch,
    });
    instance.on('error', () => {});
    await collect(instance);
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://eastus2.tts.speech.microsoft.com/cognitiveservices/v1',
    );
  });

  it.each(['short-name', 'en-US-Dummy:wrong-model', ':test'])(
    'requires a full voice with exact model suffix: %s',
    (voice) => expect(() => new TTS({ ...basic, url: TTS_URL, voice })).toThrow(/full voice ID/),
  );

  it('matches the complete model suffix case-insensitively without aliases', () => {
    expect(
      new TTS({
        ...basic,
        url: TTS_URL,
        model: 'mai-test-flash',
        voice: 'x:MAI-Test-Flash',
      }).model,
    ).toBe('mai-test-flash');
    expect(
      () =>
        new TTS({
          ...basic,
          url: TTS_URL,
          model: 'mai-test-2.1-flash',
          voice: 'x:MAI-Test-2-Flash',
        }),
    ).toThrow(/configured model/);
  });

  it('fails text and timeout limits before fetch', () => {
    const fetch = vi.fn(async () => wavResponse(PCM));
    const instance = new TTS({
      ...basic,
      url: TTS_URL,
      fetch: fetch as typeof globalThis.fetch,
      maxTextLength: 8,
    });
    expect(() => instance.synthesize(' ')).toThrow(/nonempty/);
    expect(() => instance.synthesize('a'.repeat(9))).toThrow(/maxTextLength/);
    expect(() =>
      instance.synthesize('hello', { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 0 }),
    ).toThrow(/greater than zero/);
    expect(() => instance.synthesize('hello\0world')).toThrow(/invalid in XML/);
    expect(() => instance.stream()).toThrow(/Streaming/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
