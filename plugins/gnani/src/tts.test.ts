// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESTChunkedStream,
  SSEChunkedStream,
  SynthesizeStream,
  TTS,
  WebSocketChunkedStream,
} from './tts.js';

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

describe('Gnani TTS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
  });

  it('requires an API key', () => {
    vi.stubEnv('GNANI_API_KEY', '');
    expect(() => new TTS({ apiKey: undefined })).toThrow(/API key/i);
  });

  it('accepts apiKey directly', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    expect(tts._opts.apiKey).toBe('test-key');
  });

  it('accepts apiKey from env', () => {
    vi.stubEnv('GNANI_API_KEY', 'env-key');
    const tts = new TTS();
    expect(tts._opts.apiKey).toBe('env-key');
  });

  it('defaults to Karan voice', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    expect(tts._opts.voice).toBe('Karan');
  });

  it('accepts custom voice', () => {
    const tts = new TTS({ apiKey: 'test-key', voice: 'Raju' });
    expect(tts._opts.voice).toBe('Raju');
  });

  it('accepts all documented voices', () => {
    for (const voice of ['Karan', 'Simran', 'Nara', 'Riya', 'Viraj', 'Raju']) {
      const tts = new TTS({ apiKey: 'test-key', voice });
      expect(tts._opts.voice).toBe(voice);
    }
  });

  it('rejects unsupported voices', () => {
    expect(() => new TTS({ apiKey: 'test-key', voice: 'nonexistent' })).toThrow(/not supported/i);
  });

  it('defaults to vachana-voice-v3', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    expect(tts._opts.model).toBe('vachana-voice-v3');
  });

  it('uses vachana-voice-v3 for v3 voices', () => {
    const tts = new TTS({ apiKey: 'test-key', voice: 'Simran' });
    expect(tts._opts.model).toBe('vachana-voice-v3');
    expect(tts.model).toBe('vachana-voice-v3');
  });

  it('accepts explicit model override', () => {
    const tts = new TTS({ apiKey: 'test-key', voice: 'Karan', model: 'custom-model' });
    expect(tts._opts.model).toBe('custom-model');
  });

  it('returns model and provider properties', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    expect(tts.model).toBe('vachana-voice-v3');
    expect(tts.provider).toBe('Gnani');
  });

  it('reports streaming=true', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    expect(tts.capabilities.streaming).toBe(true);
  });

  it('defaults to 16000 Hz sample rate', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    expect(tts.sampleRate).toBe(16000);
  });

  it('accepts custom sample rate', () => {
    const tts = new TTS({ apiKey: 'test-key', sampleRate: 44100 });
    expect(tts.sampleRate).toBe(44100);
  });

  it('defaults encoding and container', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    expect(tts._opts.encoding).toBe('linear_pcm');
    expect(tts._opts.container).toBe('wav');
  });

  it('accepts custom audio config', () => {
    const tts = new TTS({ apiKey: 'test-key', encoding: 'oggopus', container: 'ogg' });
    expect(tts._opts.encoding).toBe('oggopus');
    expect(tts._opts.container).toBe('ogg');
  });

  it('updateOptions can change voice', () => {
    const tts = new TTS({ apiKey: 'test-key', voice: 'Karan' });
    tts.updateOptions({ voice: 'Simran' });
    expect(tts._opts.voice).toBe('Simran');
  });

  it('updateOptions can change voice and model', () => {
    const tts = new TTS({ apiKey: 'test-key', voice: 'Karan' });
    tts.updateOptions({ voice: 'Riya', model: 'custom-model' });
    expect(tts._opts.voice).toBe('Riya');
    expect(tts._opts.model).toBe('custom-model');
  });

  it('updateOptions rejects unsupported voices', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    expect(() => tts.updateOptions({ voice: 'nonexistent' })).toThrow(/not supported/i);
  });

  it('updateOptions can change model', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    tts.updateOptions({ model: 'custom-model' });
    expect(tts._opts.model).toBe('custom-model');
  });

  it('stores synthesizeMethod options', () => {
    expect(new TTS({ apiKey: 'test-key' })._opts.synthesizeMethod).toBe('rest');
    expect(new TTS({ apiKey: 'test-key', synthesizeMethod: 'sse' })._opts.synthesizeMethod).toBe(
      'sse',
    );
    expect(
      new TTS({ apiKey: 'test-key', synthesizeMethod: 'websocket' })._opts.synthesizeMethod,
    ).toBe('websocket');
  });

  it('synthesize() routes by synthesizeMethod', () => {
    const rest = new TTS({ apiKey: 'test-key', synthesizeMethod: 'rest' }).synthesize('hello');
    rest.close();
    expect(rest).toBeInstanceOf(RESTChunkedStream);

    const sse = new TTS({ apiKey: 'test-key', synthesizeMethod: 'sse' }).synthesize('hello');
    sse.close();
    expect(sse).toBeInstanceOf(SSEChunkedStream);

    const websocket = new TTS({ apiKey: 'test-key', synthesizeMethod: 'websocket' }).synthesize(
      'hello',
    );
    websocket.close();
    expect(websocket).toBeInstanceOf(WebSocketChunkedStream);
  });

  it('defaults to Vachana API base URL', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    expect(tts._opts.baseURL).toBe('https://api.vachana.ai');
  });

  it('builds wss URL from https base', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    const stream = new SynthesizeStream(tts, tts._opts);
    stream.close();
    expect(stream.buildWsUrl()).toBe('wss://api.vachana.ai/api/v1/tts');
  });

  it('builds ws URL from http base', () => {
    const tts = new TTS({ apiKey: 'test-key', baseURL: 'http://localhost:9090' });
    const stream = new SynthesizeStream(tts, tts._opts);
    stream.close();
    expect(stream.buildWsUrl()).toBe('ws://localhost:9090/api/v1/tts');
  });

  it('defaults and accepts numChannels', () => {
    const defaults = new TTS({ apiKey: 'test-key' });
    expect(defaults._opts.numChannels).toBe(1);
    expect(defaults.numChannels).toBe(1);

    const custom = new TTS({ apiKey: 'test-key', numChannels: 2 });
    expect(custom._opts.numChannels).toBe(2);
  });

  it('defaults and accepts bitrate', () => {
    const defaults = new TTS({ apiKey: 'test-key' });
    expect(defaults._opts.bitrate).toBeUndefined();

    const custom = new TTS({ apiKey: 'test-key', bitrate: '128k' });
    expect(custom._opts.bitrate).toBe('128k');
  });

  it('rejects unsupported sample rates', () => {
    expect(() => new TTS({ apiKey: 'test-key', sampleRate: 48000 })).toThrow(/sampleRate/i);
  });

  it('accepts all documented sample rates', () => {
    for (const sampleRate of [8000, 16000, 22050, 44100]) {
      const tts = new TTS({ apiKey: 'test-key', sampleRate });
      expect(tts.sampleRate).toBe(sampleRate);
    }
  });

  it('stream() returns a SynthesizeStream instance', () => {
    const tts = new TTS({ apiKey: 'test-key' });
    const stream = tts.stream();
    stream.close();
    expect(stream).toBeInstanceOf(SynthesizeStream);
  });

  it('updateOptions preserves other fields', () => {
    const tts = new TTS({ apiKey: 'test-key', voice: 'Karan' });
    tts.updateOptions({ voice: 'Raju' });
    expect(tts._opts.voice).toBe('Raju');
    expect(tts._opts.model).toBe('vachana-voice-v3');
    expect(tts._opts.encoding).toBe('linear_pcm');
  });

  it('WebSocketChunkedStream builds correct WS URL', () => {
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'websocket' });
    const stream = tts.synthesize('hello');
    stream.close();
    expect(stream).toBeInstanceOf(WebSocketChunkedStream);
    expect((stream as WebSocketChunkedStream).buildWsUrl()).toBe('wss://api.vachana.ai/api/v1/tts');
  });
});
