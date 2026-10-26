// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { OpenAI } from 'openai';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChunkedStream, TTS } from './tts.js';

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

async function collectAudio(stream: ChunkedStream) {
  const audio = [];
  for await (const chunk of stream) {
    audio.push(chunk);
  }
  return audio;
}

describe('OpenAI TTS sample rates', () => {
  it.each([-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10.5, NaN, Infinity])(
    'rejects sampleRate %s before synthesis',
    (sampleRate) => {
      expect(() => new TTS({ apiKey: 'test-key', sampleRate })).toThrow(
        'sampleRate must be an integer of at least 10 Hz',
      );
    },
  );

  it.each([
    { name: 'omitted', opts: {}, expectedRate: 24000 },
    { name: 'undefined', opts: { sampleRate: undefined }, expectedRate: 24000 },
    { name: 'minimum', opts: { sampleRate: 10 }, expectedRate: 10 },
    { name: '44.1 kHz', opts: { sampleRate: 44100 }, expectedRate: 44100 },
  ])('preserves PCM and frame metadata for $name sampleRate', async ({ opts, expectedRate }) => {
    const samples = Int16Array.from(
      { length: Math.floor(expectedRate / 10) + 1 },
      (_, i) => i % 32768,
    );
    const client = new OpenAI({
      apiKey: 'test-key',
      fetch: async () => new Response(samples.buffer),
    });
    const tts = new TTS({ ...opts, client });
    const audio = await collectAudio(tts.synthesize('hello'));

    expect(tts.sampleRate).toBe(expectedRate);
    expect(audio.map(({ frame }) => frame.sampleRate)).toEqual([expectedRate, expectedRate]);
    expect(audio.map(({ frame }) => frame.channels)).toEqual([1, 1]);
    expect(audio.flatMap(({ frame }) => [...frame.data])).toEqual([...samples]);
    expect(audio.map(({ final }) => final)).toEqual([false, true]);
    await tts.close();
  });

  it('supports the three-argument ChunkedStream constructor', async () => {
    const tts = new TTS({ apiKey: 'test-key' });
    const samples = new Int16Array(2400);
    const stream = new ChunkedStream(tts, 'hello', Promise.resolve(new Response(samples.buffer)));
    const audio = await collectAudio(stream);

    expect(audio).toHaveLength(1);
    expect(audio[0]?.frame.sampleRate).toBe(24000);
    expect(audio[0]?.frame.samplesPerChannel).toBe(samples.length);
    await tts.close();
  });

  it('preserves connection options and abort signal positions in ChunkedStream', async () => {
    const tts = new TTS({ apiKey: 'test-key', sampleRate: 44100 });
    const samples = new Int16Array(4410);
    const abortController = new AbortController();
    const stream = new ChunkedStream(
      tts,
      'hello',
      Promise.resolve(new Response(samples.buffer)),
      { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
      abortController.signal,
    );
    const audio = await collectAudio(stream);

    expect(audio).toHaveLength(1);
    expect(audio[0]?.frame.sampleRate).toBe(44100);
    expect(stream.abortSignal.aborted).toBe(false);
    abortController.abort();
    expect(stream.abortSignal.aborted).toBe(true);
    await tts.close();
  });
});
