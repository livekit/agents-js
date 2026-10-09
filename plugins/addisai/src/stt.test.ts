// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stt } from '@livekit/agents';
import type { APIStatusError } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STT } from './stt.js';

function audioFrame(): AudioFrame {
  return new AudioFrame(new Int16Array(1_600), 16_000, 1, 1_600);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AddisAI STT', () => {
  it('maps batch transcription responses into LiveKit speech events', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('request_data')).toBe('{"language_code":"om"}');

      const audio = form.get('audio');
      expect(audio).toBeInstanceOf(File);
      expect((audio as File).type).toBe('audio/wav');
      expect((audio as File).name).toBe('audio.wav');
      const bytes = new Uint8Array(await (audio as File).arrayBuffer());
      expect(Buffer.from(bytes.subarray(0, 4)).toString('ascii')).toBe('RIFF');

      return new Response(
        JSON.stringify({
          status: 'success',
          data: {
            transcription: 'Akkam jirtu?',
            usage_metadata: {
              totalBilledDuration: '1s',
              requestId: 'stt-request-1',
            },
          },
          confidence: 0.94,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const recognizer = new STT({ apiKey: 'test-key', language: 'om' });
    const event = await recognizer.recognize(audioFrame());

    expect(recognizer.capabilities).toMatchObject({
      streaming: false,
      interimResults: false,
      alignedTranscript: false,
    });
    expect(recognizer.model).toBe('addis-whisper');
    expect(recognizer.provider).toBe('AddisAI');
    expect(event).toMatchObject({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId: 'stt-request-1',
      alternatives: [
        {
          text: 'Akkam jirtu?',
          language: 'om',
          confidence: 0.94,
          metadata: {
            usage: {
              totalBilledDuration: '1s',
              requestId: 'stt-request-1',
            },
          },
        },
      ],
    });
  });

  it('maps provider HTTP errors into LiveKit APIStatusError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-429' },
          }),
      ),
    );

    const recognizer = new STT({ apiKey: 'test-key' });
    await expect(recognizer.recognize(audioFrame())).rejects.toMatchObject({
      name: 'APIStatusError',
      statusCode: 429,
      requestId: 'req-429',
      retryable: true,
    } satisfies Partial<APIStatusError>);
  });

  it.each(['en', 'ha', 'sw', ''])('rejects unsupported language %j', (language) => {
    expect(() => new STT({ apiKey: 'test-key', language })).toThrow(/language must be "am".*"om"/);
  });

  it('rejects streaming because the provider endpoint is batch-only', () => {
    const recognizer = new STT({ apiKey: 'test-key' });
    expect(() => recognizer.stream()).toThrow(/batch-only/i);
  });
});
