// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STT, SpeechStream } from './stt.js';

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    WebSocket: class MockWebSocket extends EventEmitter {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        super();
        queueMicrotask(() => this.emit('open'));
      }

      send() {}

      close() {
        this.emit('close', 1000);
      }
    },
  };
});

describe('Gnani STT', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires an API key', () => {
    vi.stubEnv('GNANI_API_KEY', '');
    expect(() => new STT({ apiKey: undefined })).toThrow(/API key/i);
  });

  it('accepts apiKey directly', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect(stt._opts.apiKey).toBe('test-key');
  });

  it('accepts apiKey from env', () => {
    vi.stubEnv('GNANI_API_KEY', 'env-key');
    const stt = new STT();
    expect(stt._opts.apiKey).toBe('env-key');
  });

  it('defaults to en-IN', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect(stt._opts.language).toBe('en-IN');
  });

  it('accepts custom language', () => {
    const stt = new STT({ apiKey: 'test-key', language: 'hi-IN' });
    expect(stt._opts.language).toBe('hi-IN');
  });

  it('defaults to 16000 Hz sample rate', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect(stt._opts.sampleRate).toBe(16000);
  });

  it('accepts 8000 Hz sample rate', () => {
    const stt = new STT({ apiKey: 'test-key', sampleRate: 8000 });
    expect(stt._opts.sampleRate).toBe(8000);
  });

  it('rejects invalid sample rates', () => {
    expect(() => new STT({ apiKey: 'test-key', sampleRate: 44100 })).toThrow(/sampleRate/i);
  });

  it('reports streaming=true and interimResults=false', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect(stt.capabilities.streaming).toBe(true);
    expect(stt.capabilities.interimResults).toBe(false);
  });

  it('returns model and provider properties', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect(stt.model).toBe('vachana-stt-v3');
    expect(stt.provider).toBe('Gnani');
  });

  it('defaults to Vachana API base URL', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect(stt._opts.baseURL).toBe('https://api.vachana.ai');
  });

  it('accepts custom base URL', () => {
    const stt = new STT({ apiKey: 'test-key', baseURL: 'https://custom.api.com' });
    expect(stt._opts.baseURL).toBe('https://custom.api.com');
  });

  it('uses only apiKey for authentication', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect('organizationId' in stt._opts).toBe(false);
    expect('userId' in stt._opts).toBe(false);
  });

  it('builds wss URL from https base', () => {
    const stt = new STT({ apiKey: 'test-key' });
    const stream = new SpeechStream(stt, {
      apiKey: 'test-key',
      language: 'en-IN',
      sampleRate: 16000,
      baseURL: 'https://api.vachana.ai',
      format: 'verbatim',
      itnNativeNumerals: false,
    });
    stream.close();
    expect(stream.buildWsUrl()).toBe('wss://api.vachana.ai/stt/v3/stream');
  });

  it('builds ws URL from http base', () => {
    const stt = new STT({ apiKey: 'test-key' });
    const stream = new SpeechStream(stt, {
      apiKey: 'test-key',
      language: 'en-IN',
      sampleRate: 16000,
      baseURL: 'http://localhost:8080',
      format: 'verbatim',
      itnNativeNumerals: false,
    });
    stream.close();
    expect(stream.buildWsUrl()).toBe('ws://localhost:8080/stt/v3/stream');
  });

  it('defaults format to verbatim', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect(stt._opts.format).toBe('verbatim');
  });

  it('accepts transcribe format for ITN', () => {
    const stt = new STT({ apiKey: 'test-key', format: 'transcribe' });
    expect(stt._opts.format).toBe('transcribe');
  });

  it('defaults preferredLanguage to undefined', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect(stt._opts.preferredLanguage).toBeUndefined();
  });

  it('accepts custom preferredLanguage', () => {
    const stt = new STT({ apiKey: 'test-key', preferredLanguage: 'hi-IN' });
    expect(stt._opts.preferredLanguage).toBe('hi-IN');
  });

  it('defaults itnNativeNumerals to false', () => {
    const stt = new STT({ apiKey: 'test-key' });
    expect(stt._opts.itnNativeNumerals).toBe(false);
  });

  it('accepts itnNativeNumerals=true', () => {
    const stt = new STT({ apiKey: 'test-key', format: 'transcribe', itnNativeNumerals: true });
    expect(stt._opts.itnNativeNumerals).toBe(true);
  });

  it('warns about deprecated auth kwargs without raising', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stt = new STT({ apiKey: 'test-key', organizationId: 'old', userId: 'old' });
    expect(stt._opts.apiKey).toBe('test-key');
    warn.mockRestore();
  });

  it('stream() returns a SpeechStream instance', () => {
    const stt = new STT({ apiKey: 'test-key' });
    const stream = stt.stream();
    stream.close();
    expect(stream).toBeInstanceOf(SpeechStream);
  });

  it('stream() uses the configured language', () => {
    const stt = new STT({ apiKey: 'test-key', language: 'hi-IN' });
    const stream = stt.stream();
    stream.close();
    expect(stream._opts.language).toBe('hi-IN');
  });
});
