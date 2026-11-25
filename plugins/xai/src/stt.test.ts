// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { STT, type STTOptions, buildSTTWebSocketURL } from './stt.js';

const hasXAIApiKey = Boolean(process.env.XAI_API_KEY);

if (hasXAIApiKey) {
  describe('xAI STT', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('xAI STT', () => {
    it.skip('integration tests require XAI_API_KEY', () => {});
  });
}

describe('xAI STT unit', () => {
  const options: STTOptions = {
    interimResults: true,
    sampleRate: 16000,
    enableDiarization: false,
    language: 'en',
    endpointing: 100,
  };

  it('forwards the selected STT model in the websocket URL', () => {
    const url = buildSTTWebSocketURL({
      ...options,
      model: 'grok-voice-transcribe-2.0',
    });
    expect(url.searchParams.get('model')).toBe('grok-voice-transcribe-2.0');
  });

  it('lets xAI choose its default STT model when none is configured', () => {
    const url = buildSTTWebSocketURL(options);
    expect(url.searchParams.has('model')).toBe(false);
  });

  it('throws when no API key is provided', () => {
    const orig = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      expect(() => new STT()).toThrow(/API key is required/);
    } finally {
      if (orig !== undefined) process.env.XAI_API_KEY = orig;
    }
  });

  it('reports correct capabilities', () => {
    const instance = new STT({ apiKey: 'dummy' });
    expect(instance.capabilities.streaming).toBe(true);
    expect(instance.capabilities.interimResults).toBe(true);
    expect(instance.capabilities.alignedTranscript).toBe('word');
  });

  it('respects interimResults=false', () => {
    const instance = new STT({ apiKey: 'dummy', interimResults: false });
    expect(instance.capabilities.interimResults).toBe(false);
  });

  it('stream() returns a SpeechStream', () => {
    const instance = new STT({ apiKey: 'dummy' });
    const stream = instance.stream();
    expect(stream).toBeDefined();
    expect(stream.label).toBe('xai.SpeechStream');
    stream.close();
  });
});
