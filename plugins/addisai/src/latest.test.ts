// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel } from './realtime.js';
import { ScribeSTT } from './scribe.js';
import { StreamingTTS } from './streaming_tts.js';

afterEach(() => vi.unstubAllGlobals());

describe('AddisAI current APIs', () => {
  it('uses the current Scribe transcription contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe('/api/v1/scribe/transcribe');
        expect(url.searchParams.get('backend')).toBe('turbo');
        expect(url.searchParams.get('speakers')).toBe('true');
        expect((init?.body as FormData).get('audio')).toBeInstanceOf(File);
        return new Response(
          JSON.stringify({ data: { text: 'ሰላም', usage: { settled: true, credits_used: 1 } } }),
          { status: 200 },
        );
      }),
    );

    const client = new ScribeSTT({ apiKey: 'test-key', backend: 'turbo', speakers: true });
    const event = await client.recognize(new AudioFrame(new Int16Array(1600), 16_000, 1, 1600));
    expect(client.capabilities).toMatchObject({ streaming: true, interimResults: true });
    expect(event.alternatives[0]?.text).toBe('ሰላም');
  });

  it('exposes streaming TTS and conversational duplex capabilities', () => {
    const voice = new StreamingTTS({ apiKey: 'test-key' });
    expect(voice.capabilities.streaming).toBe(true);
    expect(voice.sampleRate).toBe(44_100);

    const model = new RealtimeModel({ apiKey: 'test-key' });
    expect(model.model).toBe('አሌፍ-1.2-realtime-audio');
    expect(model.capabilities.userTranscription).toBe(false);
  });
});
