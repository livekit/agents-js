// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD as BaseVAD, type VADStream } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { SpeechStream } from './stt.js';
import {
  STT,
  _normalizeRealtimeTurnDetection,
  buildRealtimeSttUrl,
  buildRealtimeTranscriptionConfig,
} from './stt.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

class FakeVAD extends BaseVAD {
  label = 'fake-vad';

  stream(): VADStream {
    return {} as VADStream;
  }
}

async function waitFor(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

describe('OpenAI STT options', () => {
  it('defaults to realtime whisper streaming', () => {
    const openai = new STT({ apiKey: 'test-key', vad: new FakeVAD({ updateInterval: 1 }) });

    expect(openai.model).toBe('gpt-realtime-whisper');
    expect(openai.capabilities.streaming).toBe(true);
    expect(openai.capabilities.interimResults).toBe(true);
    expect(openai.capabilities.alignedTranscript).toBe(false);
  });

  it('supports explicitly opting into batch STT', () => {
    const openai = new STT({ apiKey: 'test-key', useRealtime: false });

    expect(openai.model).toBe('whisper-1');
    expect(openai.capabilities.streaming).toBe(false);
    expect(() => openai.stream()).toThrow(/useRealtime/i);
  });

  it('keeps Groq and OVHcloud helper instances in batch mode', () => {
    const groq = STT.withGroq({ apiKey: 'test-key' });
    const ovhcloud = STT.withOVHcloud({ apiKey: 'test-key' });

    expect(groq.capabilities.streaming).toBe(false);
    expect(() => groq.stream()).toThrow(/useRealtime/i);
    expect(ovhcloud.capabilities.streaming).toBe(false);
    expect(() => ovhcloud.stream()).toThrow(/useRealtime/i);
  });

  it('preserves the current model when updateOptions enables realtime without a model', () => {
    const vad = new FakeVAD({ updateInterval: 1 });
    const openai = new STT({
      apiKey: 'test-key',
      model: 'gpt-4o-realtime-preview',
      useRealtime: false,
      vad,
    });

    openai.updateOptions({ useRealtime: true, vad });

    expect(openai.model).toBe('gpt-4o-realtime-preview');
  });

  it('removes closed speech streams before propagating option updates', () => {
    const vad = new FakeVAD({ updateInterval: 1 });
    const openai = new STT({ apiKey: 'test-key', vad });
    const stream = openai.stream() as SpeechStream;
    const updateOptions = vi.spyOn(stream, '_updateOptions');

    stream.close();
    openai.updateOptions({ vad });

    expect(updateOptions).not.toHaveBeenCalled();
  });

  it('sends keywords and plural languages to context-hint models', () => {
    expect(
      buildRealtimeTranscriptionConfig({
        model: 'gpt-live-transcribe',
        prompt: 'A customer support call.',
        keywords: ['premium plan', 'AC-42'],
        languages: ['en', 'fr'],
      }),
    ).toEqual({
      model: 'gpt-live-transcribe',
      prompt: 'A customer support call.',
      keywords: ['premium plan', 'AC-42'],
      languages: ['en', 'fr'],
    });
  });

  it('normalizes context-hint languages to unique ISO-639 base codes', () => {
    const config = buildRealtimeTranscriptionConfig({
      model: 'gpt-transcribe',
      languages: ['en-US', 'yue', 'zh-CN', 'zh-TW'],
    });

    expect(config.languages).toEqual(['en', 'yue', 'zh']);
  });

  it('keeps singular language on earlier models', () => {
    const config = buildRealtimeTranscriptionConfig({
      model: 'gpt-4o-mini-transcribe',
      languages: ['en-US'],
      keywords: [],
    });

    expect(config.language).toBe('en');
    expect(config).not.toHaveProperty('languages');
    expect(config).not.toHaveProperty('keywords');
  });

  it('omits language when detection is enabled', () => {
    const config = buildRealtimeTranscriptionConfig({
      model: 'gpt-4o-mini-transcribe',
      languages: [],
    });

    expect(config).not.toHaveProperty('language');
  });

  it('rejects unsupported plural languages and keywords', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          model: 'gpt-4o-transcribe',
          language: ['en', 'fr'],
          useRealtime: false,
        }),
    ).toThrow(/accepts a single language/);
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          model: 'gpt-4o-transcribe',
          keywords: ['AC-42'],
          useRealtime: false,
        }),
    ).toThrow(/keywords are only supported/);
  });

  it('rejects a model switch before applying incompatible hints', () => {
    const openai = new STT({
      apiKey: 'test-key',
      model: 'gpt-live-transcribe',
      keywords: ['AC-42'],
      language: ['en', 'fr'],
      vad: null,
    });

    expect(() => openai.updateOptions({ model: 'gpt-4o-transcribe' })).toThrow(
      /keywords are only supported/,
    );
    expect(openai.model).toBe('gpt-live-transcribe');
    expect(openai.capabilities.keyterms).toBe(true);
  });

  it.each([
    ['gpt-transcribe', true],
    ['gpt-live-transcribe', true],
    ['gpt-4o-transcribe', false],
    ['whisper-1', false],
  ])('sets keyterm capability for %s', (model, supported) => {
    const openai = new STT({ apiKey: 'test-key', model, useRealtime: false });
    expect(openai.capabilities.keyterms).toBe(supported);
  });

  it.each([
    ['gpt-live-transcribe', true],
    ['gpt-realtime-whisper', true],
    ['gpt-4o-mini-transcribe', false],
    ['whisper-1', false],
  ])('defaults %s to its supported transport', (model, realtime) => {
    const openai = new STT({ apiKey: 'test-key', model, vad: null });
    expect(openai.capabilities.streaming).toBe(realtime);
  });

  it('requires realtime transport when switching to a realtime-only model', () => {
    const openai = new STT({
      apiKey: 'test-key',
      model: 'gpt-transcribe',
      useRealtime: false,
    });

    expect(() => openai.updateOptions({ model: 'gpt-live-transcribe' })).toThrow(
      /served only over the realtime API/,
    );
  });

  it('loads the bundled VAD for realtime-only models', () => {
    const openai = new STT({ apiKey: 'test-key', model: 'gpt-live-transcribe' });
    expect(() => openai.stream().close()).not.toThrow();
  });

  it('fills in server_vad when turn detection omits its discriminator', () => {
    expect(
      _normalizeRealtimeTurnDetection('gpt-4o-mini-transcribe', {
        silence_duration_ms: 800,
      }),
    ).toEqual({ type: 'server_vad', silence_duration_ms: 800 });
  });

  it('rejects turn detection for gpt-live-transcribe', () => {
    expect(
      _normalizeRealtimeTurnDetection('gpt-live-transcribe', { type: 'server_vad' }),
    ).toBeNull();
  });

  it('merges session keyterms behind user keywords', () => {
    const openai = new STT({
      apiKey: 'test-key',
      model: 'gpt-live-transcribe',
      keywords: ['AC-42', 'billing'],
      vad: null,
    });
    const stream = openai.stream() as SpeechStream;
    const updateOptions = vi.spyOn(stream, '_updateOptions');

    openai._updateSessionKeyterms(['billing', 'Acme Corp']);

    expect(updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: ['AC-42', 'billing', 'Acme Corp'] }),
    );
    stream.close();
  });

  it('falls back to the last specified language when detection is disabled', () => {
    const openai = new STT({
      apiKey: 'test-key',
      model: 'gpt-live-transcribe',
      language: 'en',
      vad: null,
    });
    openai.updateOptions({ language: 'de' });
    openai.updateOptions({ detectLanguage: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    openai.updateOptions({ detectLanguage: false });
    const stream = openai.stream() as SpeechStream;

    expect(stream.languages).toEqual(['de']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to de'));
    warn.mockRestore();
    stream.close();
  });
});

describe('OpenAI STT file transcription context', () => {
  it('sends plural hints and reports the detected language', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ text: 'bonjour, hello', languages: [{ code: 'fr' }] });
    const client = { audio: { transcriptions: { create } } } as unknown as OpenAI;
    const openai = new STT({
      apiKey: 'test-key',
      client,
      model: 'gpt-transcribe',
      language: ['en', 'fr'],
      keywords: ['premium plan', 'AC-42'],
      useRealtime: false,
    });

    const event = await openai.recognize([new AudioFrame(new Int16Array(2400), 24000, 1, 2400)]);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-transcribe',
        languages: ['en', 'fr'],
        keywords: ['premium plan', 'AC-42'],
      }),
      expect.any(Object),
    );
    expect(event.alternatives?.[0].language).toBe('fr');
  });
});

describe('OpenAI realtime STT context', () => {
  it('updates hints in place and reconnects for a model change', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('missing server address');
    const messages: Record<string, unknown>[] = [];
    let connections = 0;
    server.on('connection', (socket) => {
      connections += 1;
      socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    });
    const openai = new STT({
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      model: 'gpt-live-transcribe',
      vad: null,
    });
    const stream = openai.stream();

    await waitFor(() => messages.length === 1);
    openai.updateOptions({ keywords: ['Acme Corp'], prompt: 'a support call' });
    await waitFor(() => messages.length === 2);
    expect(messages[1]).toMatchObject({
      session: {
        audio: {
          input: {
            transcription: { keywords: ['Acme Corp'], prompt: 'a support call' },
          },
        },
      },
    });
    expect(connections).toBe(1);

    openai.updateOptions({ keywords: [], prompt: '' });
    await waitFor(() => messages.length === 3);
    expect(messages[2]).toMatchObject({
      session: { audio: { input: { transcription: { keywords: [], prompt: '' } } } },
    });

    openai.updateOptions({ detectLanguage: true });
    await waitFor(() => connections === 2 && messages.length === 4);
    expect(
      (
        ((messages[3]!.session as Record<string, unknown>).audio as Record<string, unknown>)
          .input as Record<string, unknown>
      ).transcription,
    ).not.toHaveProperty('languages');

    openai.updateOptions({ model: 'gpt-4o-mini-transcribe', keywords: [], language: 'fr' });
    await waitFor(() => connections === 3 && messages.length === 5);
    expect(messages[4]).toMatchObject({
      session: {
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'fr' },
            turn_detection: { type: 'server_vad' },
          },
        },
      },
    });

    stream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('keeps each stream language independent', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('missing server address');
    const messages: Record<string, unknown>[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    });
    const openai = new STT({
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      model: 'gpt-live-transcribe',
      language: 'en',
      vad: null,
    });
    const english = openai.stream() as SpeechStream;
    const french = openai.stream({ language: 'fr' }) as SpeechStream;
    await waitFor(() => messages.length === 2);

    expect(english.languages).toEqual(['en']);
    expect(french.languages).toEqual(['fr']);
    french.updateOptions({ language: 'de' });
    await waitFor(() => messages.length === 3);
    expect(english.languages).toEqual(['en']);
    expect(french.languages).toEqual(['de']);

    english.close();
    french.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports the language detected by the realtime model', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('missing server address');
    server.on('connection', (socket) => {
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'item_1',
            transcript: 'bonjour, hello',
            languages: [{ code: 'fr' }, { code: 'en' }],
          }),
        );
      });
    });
    const openai = new STT({
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      model: 'gpt-live-transcribe',
      language: ['en', 'fr'],
      vad: null,
    });
    const stream = openai.stream();

    const event = await stream.next();

    expect(event.value.alternatives?.[0]).toMatchObject({
      text: 'bonjour, hello',
      language: 'fr',
    });
    stream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('buildRealtimeSttUrl', () => {
  it('points at OpenAI realtime with intent but omits model on the native endpoint', () => {
    // OpenAI's native /realtime endpoint rejects `?model=` with
    // invalid_request_error.invalid_model when intent=transcription, so the
    // model is conveyed via the subsequent session.update instead.
    const url = new URL(buildRealtimeSttUrl(undefined, 'gpt-realtime-whisper'));

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.openai.com');
    expect(url.pathname).toBe('/v1/realtime');
    expect(url.searchParams.get('intent')).toBe('transcription');
    expect(url.searchParams.get('model')).toBe(null);
  });

  it('omits the model when an explicit baseURL still points at api.openai.com', () => {
    const url = new URL(buildRealtimeSttUrl('https://api.openai.com/v1', 'gpt-4o-mini-transcribe'));

    expect(url.host).toBe('api.openai.com');
    expect(url.pathname).toBe('/v1/realtime');
    expect(url.searchParams.get('intent')).toBe('transcription');
    expect(url.searchParams.get('model')).toBe(null);
  });

  it('upgrades https baseURL to wss and appends /realtime when path is /v1', () => {
    const url = new URL(
      buildRealtimeSttUrl('https://gateway.example.com/v1', 'gpt-4o-mini-transcribe'),
    );

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('gateway.example.com');
    expect(url.pathname).toBe('/v1/realtime');
    expect(url.searchParams.get('model')).toBe('gpt-4o-mini-transcribe');
  });

  it('preserves an existing /realtime path without duplicating it', () => {
    const url = new URL(
      buildRealtimeSttUrl('wss://gateway.example.com/v1/realtime', 'gpt-realtime-whisper'),
    );

    expect(url.pathname).toBe('/v1/realtime');
    expect(url.searchParams.get('model')).toBe('gpt-realtime-whisper');
  });

  it('appends /realtime to a non-/v1 path', () => {
    const url = new URL(
      buildRealtimeSttUrl('https://gateway.example.com/proxy/openai', 'gpt-realtime-whisper'),
    );

    expect(url.pathname).toBe('/proxy/openai/realtime');
    expect(url.searchParams.get('intent')).toBe('transcription');
    expect(url.searchParams.get('model')).toBe('gpt-realtime-whisper');
  });

  it('downgrades http baseURL to ws (not wss)', () => {
    const url = new URL(
      buildRealtimeSttUrl('http://gateway.example.com/v1', 'gpt-realtime-whisper'),
    );

    expect(url.protocol).toBe('ws:');
    expect(url.host).toBe('gateway.example.com');
    expect(url.pathname).toBe('/v1/realtime');
    expect(url.searchParams.get('intent')).toBe('transcription');
    expect(url.searchParams.get('model')).toBe('gpt-realtime-whisper');
  });

  it('downgrades http baseURL with a trailing slash to ws', () => {
    const url = new URL(
      buildRealtimeSttUrl('http://gateway.example.com/v1/', 'gpt-realtime-whisper'),
    );

    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/v1/realtime');
  });
});

if (hasOpenAIApiKey) {
  describe('OpenAI STT integration', async () => {
    const vad = await VAD.load();
    await stt(new STT({ useRealtime: false }), vad, { streaming: false });
  });

  describe('OpenAI STT realtime integration', async () => {
    const vad = await VAD.load();
    await stt(new STT({ vad }), vad, {
      nonStreaming: false,
    });
  });
} else {
  describe('OpenAI', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
