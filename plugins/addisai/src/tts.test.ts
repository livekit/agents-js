// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TTS } from './tts.js';

const NO_RETRY: APIConnectOptions = {
  maxRetry: 0,
  retryIntervalMs: 0,
  timeoutMs: 1_000,
};

function pcmWav(samples = 1_600): Uint8Array {
  const dataSize = samples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AddisAI TTS', () => {
  it('generates and downloads a PCM WAV clip', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });

      if (url.endsWith('/api/v1/voice/generations')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'provider-clip-1',
              audio_url: 'https://audio.example.test/clip.wav',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(pcmWav(), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const synthesizer = new TTS({
      apiKey: 'test-key',
      language: 'om',
      voice: 'om-test-voice',
      speed: 1.1,
    });
    const events = [];
    for await (const event of synthesizer.synthesize('Akkam jirtu?', NO_RETRY)) {
      events.push(event);
    }

    const generationBody = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(generationBody).toMatchObject({
      text: 'Akkam jirtu?',
      voice_id: 'om-test-voice',
      language: 'om',
      output_format: 'pcm_16000',
      voice_settings: { speed: 1.1 },
    });
    expect(typeof generationBody.client_request_id).toBe('string');
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    expect(events.every((event) => event.requestId !== 'provider-clip-1')).toBe(true);
    expect(events.every((event) => event.segmentId === 'provider-clip-1')).toBe(true);
    expect(events.at(-1)?.final).toBe(true);
    expect(
      events.reduce(
        (duration, event) => duration + event.frame.samplesPerChannel / event.frame.sampleRate,
        0,
      ),
    ).toBeCloseTo(0.1);
  });

  it('keeps the provider idempotency key stable across LiveKit retries', async () => {
    const clientRequestIds: string[] = [];
    let generationAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/v1/voice/generations')) {
        const body = JSON.parse(String(init?.body)) as { client_request_id: string };
        clientRequestIds.push(body.client_request_id);
        generationAttempt += 1;
        if (generationAttempt === 1) {
          return new Response(JSON.stringify({ error: { message: 'try again' } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            data: {
              id: 'stable-provider-clip',
              audio_url: 'https://audio.example.test/retry.wav',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(pcmWav(), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const synthesizer = new TTS({ apiKey: 'test-key' });
    await synthesizer
      .synthesize('retry me', {
        maxRetry: 1,
        retryIntervalMs: 0,
        timeoutMs: 1_000,
      })
      .collect();

    expect(clientRequestIds).toHaveLength(2);
    expect(new Set(clientRequestIds).size).toBe(1);
  });

  it.each(['en', 'ha', 'sw', ''])('rejects unsupported language %j', (language) => {
    expect(() => new TTS({ apiKey: 'test-key', language })).toThrow(/language must be "am".*"om"/);
  });

  it('rejects native streaming because Addis Voices 2 is non-streaming', () => {
    const synthesizer = new TTS({ apiKey: 'test-key' });
    expect(() => synthesizer.stream()).toThrow(/streaming is not supported/i);
  });
});
