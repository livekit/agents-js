// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD as BaseVAD, type VADStream } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, expect, it, vi } from 'vitest';
import type { SpeechStream } from './stt.js';
import { STT, buildRealtimeSttUrl } from './stt.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

class FakeVAD extends BaseVAD {
  label = 'fake-vad';

  stream(): VADStream {
    return {} as VADStream;
  }
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
    const updateOptions = vi.spyOn(stream, 'updateOptions');

    stream.close();
    openai.updateOptions({ vad });

    expect(updateOptions).not.toHaveBeenCalled();
  });
});

describe('buildRealtimeSttUrl', () => {
  it('points at OpenAI realtime with intent and model when no baseURL is set', () => {
    const url = new URL(buildRealtimeSttUrl(undefined, 'gpt-realtime-whisper'));

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.openai.com');
    expect(url.pathname).toBe('/v1/realtime');
    expect(url.searchParams.get('intent')).toBe('transcription');
    expect(url.searchParams.get('model')).toBe('gpt-realtime-whisper');
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
