// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TTS } from './tts.js';

initializeLogger({ pretty: false, level: 'silent' });

const hasGandrConfig = Boolean(process.env.GANDR_API_KEY && process.env.OPENAI_API_KEY);

function pcmChunk(byteLength: number): Uint8Array {
  const chunk = new Uint8Array(byteLength);
  for (let i = 0; i < chunk.length; i += 2) {
    chunk[i] = 1;
  }
  return chunk;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

describe('Gandr TTS', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits pcm audio from a 200 /audio/speech body', async () => {
    const bodyController = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(pcmChunk(3200));
          controller.enqueue(pcmChunk(3200));
          controller.close();
        }, 0);
      },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(bodyController, {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    );

    const gandrTTS = new TTS({ apiKey: 'test-gandr-key' });
    const stream = gandrTTS.synthesize('hello world');

    const firstResult = await withTimeout(stream.next(), 1000);
    expect(firstResult).not.toBe('timeout');
    if (firstResult === 'timeout') return;
    expect(firstResult.done).toBe(false);
    expect(firstResult.value.frame.samplesPerChannel).toBe(1600);

    const finalResult = await stream.next();
    expect(finalResult.done).toBe(false);
    expect(finalResult.value.final).toBe(true);

    const doneResult = await stream.next();
    expect(doneResult.done).toBe(true);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://tts.gandr.ai/v1/audio/speech');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      model: 'tts-1',
      input: 'hello world',
      voice: 'gandr-mia',
      response_format: 'pcm',
      speed: 1,
    });
  });

  it('maps a non-2xx status into APIStatusError with a retryable flag', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad_request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const gandrTTS = new TTS({ apiKey: 'test-gandr-key' });
    const stream = gandrTTS.synthesize('boom');

    await expect(stream.next()).rejects.toMatchObject({
      name: 'APIStatusError',
      statusCode: 400,
      retryable: false,
    });
  });

  it('maps a network failure into APIConnectionError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const gandrTTS = new TTS({ apiKey: 'test-gandr-key' });

    await expect(gandrTTS.synthesize('boom').next()).rejects.toMatchObject({
      name: 'APIConnectionError',
    });
  });

  it('throws when no api key is configured', () => {
    const key = process.env.GANDR_API_KEY;
    delete process.env.GANDR_API_KEY;
    try {
      expect(() => new TTS()).toThrow('GANDR_API_KEY');
    } finally {
      if (key) process.env.GANDR_API_KEY = key;
    }
  });
});

if (hasGandrConfig) {
  describe('Gandr TTS live', async () => {
    await tts(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('Gandr TTS live', () => {
    it.skip('requires GANDR_API_KEY and OPENAI_API_KEY', () => {});
  });
}
