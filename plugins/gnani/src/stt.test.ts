// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STT, SpeechStream } from './stt.js';

interface MockWebSocket extends EventEmitter {
  options?: { handshakeTimeout?: number };
  sent: unknown[];
  closed: boolean;
}

const wsState = vi.hoisted(() => ({
  instances: [] as MockWebSocket[],
  autoOpen: true,
}));

vi.mock('ws', () => {
  return {
    WebSocket: class MockWebSocket extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      sent: unknown[] = [];
      closed = false;
      options?: { handshakeTimeout?: number };

      constructor(_url: string, options?: { handshakeTimeout?: number }) {
        super();
        this.options = options;
        wsState.instances.push(this);
        if (wsState.autoOpen) queueMicrotask(() => this.emit('open'));
      }

      send(data: unknown) {
        this.sent.push(data);
      }

      close() {
        this.closed = true;
        this.emit('close', 1000);
      }
    },
  };
});

describe('Gnani STT', () => {
  beforeEach(() => {
    wsState.instances.length = 0;
    wsState.autoOpen = true;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
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

  it('parses WebSocket text frames delivered as non-binary Buffers', async () => {
    const stt = new STT({ apiKey: 'test-key' });
    const stream = stt.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 100 },
    });
    await vi.waitFor(() => expect(wsState.instances.length).toBeGreaterThan(0));
    const ws = wsState.instances.at(-1)!;

    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'transcript', text: 'namaste', segment_id: 'seg-1' })),
      false,
    );

    const result = await Promise.race([
      stream.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('text Buffer was not parsed')), 50),
      ),
    ]);
    stream.close();
    expect(result.value?.alternatives[0]?.text).toBe('namaste');
  });

  it('drains final responses for one second after audio input ends', async () => {
    const stt = new STT({ apiKey: 'test-key' });
    const stream = stt.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1500 },
    });
    await vi.waitFor(() => expect(wsState.instances.length).toBeGreaterThan(0));
    const ws = wsState.instances.at(-1)!;

    stream.pushFrame(AudioFrame.create(16000, 1, 160));
    stream.endInput();
    setTimeout(() => {
      ws.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'transcript', text: 'final', segment_id: 'seg-2' })),
        false,
      );
    }, 25);

    const result = await Promise.race([
      stream.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('final response was not drained')), 100),
      ),
    ]);
    stream.close();
    expect(result.value?.alternatives[0]?.text).toBe('final');
  });

  it('uses connOptions timeout for WebSocket connection and receive', async () => {
    const stt = new STT({ apiKey: 'test-key' });
    const stream = stt.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 200 },
    });
    await vi.waitFor(() => expect(wsState.instances.length).toBeGreaterThan(0));
    const ws = wsState.instances.at(-1)!;
    await vi.waitFor(() => expect(ws.listenerCount('message')).toBeGreaterThan(0));

    expect(ws.options?.handshakeTimeout).toBe(200);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'connected' })), false);
    stream.close();
  });

  it('rejects provider close before audio input completes', async () => {
    const stream = Object.create(SpeechStream.prototype);
    Reflect.set(stream, 'timeoutMs', 100);
    Reflect.set(stream, 'abortController', new AbortController());
    Reflect.set(stream, '_opts', { language: 'en-IN' });
    Reflect.set(stream, 'queue', { put: vi.fn() });
    const ws = new EventEmitter();
    const receive = Reflect.apply(Reflect.get(stream, 'receiveMessages'), stream, [
      ws,
      { allowClose: false },
    ]);
    const rejection = expect(receive).rejects.toMatchObject({ name: 'APIConnectionError' });

    ws.emit('close', 1006);

    await rejection;
  });

  it('times out a transport-connected socket with no provider response', async () => {
    vi.useFakeTimers();
    const stream = Object.create(SpeechStream.prototype);
    Reflect.set(stream, 'timeoutMs', 25);
    Reflect.set(stream, 'abortController', new AbortController());
    Reflect.set(stream, '_opts', { language: 'en-IN' });
    Reflect.set(stream, 'queue', { put: vi.fn() });
    const ws = new EventEmitter();
    const receive = Reflect.apply(Reflect.get(stream, 'receiveMessages'), stream, [
      ws,
      { allowClose: false },
    ]);
    const rejection = expect(receive).rejects.toMatchObject({ name: 'APITimeoutError' });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it('closes a pending WebSocket handshake when the stream aborts', async () => {
    vi.useFakeTimers();
    wsState.autoOpen = false;
    const stt = new STT({ apiKey: 'test-key' });
    const stream = stt.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(0);
    const ws = wsState.instances.at(-1)!;

    stream.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.closed).toBe(true);
  });

  it('closes a pending WebSocket receive when the stream aborts', async () => {
    vi.useFakeTimers();
    const stt = new STT({ apiKey: 'test-key' });
    const stream = stt.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(0);
    const ws = wsState.instances.at(-1)!;

    stream.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.closed).toBe(true);
  });

  it('allows provider close during the one-second final drain', async () => {
    vi.useFakeTimers();
    const stt = new STT({ apiKey: 'test-key' });
    const errors: Error[] = [];
    stt.on('error', (event) => errors.push(event.error));
    const stream = stt.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(0);
    const ws = wsState.instances.at(-1)!;
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'connected' })), false);

    stream.endInput();
    await vi.advanceTimersByTimeAsync(0);
    ws.emit('close', 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toHaveLength(0);
    stream.close();
  });
});
