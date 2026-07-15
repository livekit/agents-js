// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESTChunkedStream,
  SSEChunkedStream,
  SynthesizeStream,
  TTS,
  WebSocketChunkedStream,
} from './tts.js';

interface MockWebSocket extends EventEmitter {
  options?: { handshakeTimeout?: number };
  sent: unknown[];
  closed: boolean;
  terminated: boolean;
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
      terminated = false;
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

      terminate() {
        this.terminated = true;
        this.closed = true;
        this.emit('close', 1006);
      }
    },
  };
});

const swallowExpectedRejection = (reason: unknown) => {
  if (
    reason instanceof Error &&
    ['APIConnectionError', 'APIStatusError', 'APITimeoutError'].includes(reason.name)
  ) {
    return;
  }
  throw reason;
};
beforeAll(() => process.on('unhandledRejection', swallowExpectedRejection));
afterAll(() => void process.off('unhandledRejection', swallowExpectedRejection));

describe('Gnani TTS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    wsState.instances.length = 0;
    wsState.autoOpen = true;
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
    const tts = new TTS({ apiKey: 'test-key', encoding: 'linear_pcm', container: 'raw' });
    expect(tts._opts.encoding).toBe('linear_pcm');
    expect(tts._opts.container).toBe('raw');
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

  it('strips the WAV container before REST audio is decoded as PCM', async () => {
    const wav = wavChunk(3200, 7);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(wav))),
    );
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'rest' });

    const frame = await tts.synthesize('hello').collect();

    expect(frame.data[0]).toBe(7);
    expect(frame.samplesPerChannel).toBe(1600);
  });

  it('rejects encoded output formats that are not decoded by the plugin', () => {
    expect(() => new TTS({ apiKey: 'test-key', encoding: 'oggopus', container: 'ogg' })).toThrow(
      /unsupported audio format/i,
    );
  });

  it('emits SSE audio before the terminal event', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'sse' });
    const stream = tts.synthesize('hello');
    const encoder = new TextEncoder();

    controller?.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ audio: wavChunk(3200, 11).toString('base64') })}\r\n\r\n`,
      ),
    );

    try {
      const first = await Promise.race([
        stream.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SSE audio was buffered until completion')), 50),
        ),
      ]);
      expect(first.value?.frame.data[0]).toBe(11);
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify({ is_final: true })}\r\n\r\n`));
      controller?.close();
      for await (const _audio of stream) {
        // Drain the stream after observing the incremental frame.
      }
    } finally {
      stream.close();
    }
  });

  it('parses non-binary WebSocket Buffers and emits audio incrementally', async () => {
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'websocket' });
    const stream = tts.synthesize('hello');
    await vi.waitFor(() => expect(wsState.instances.length).toBeGreaterThan(0));
    const ws = wsState.instances.at(-1)!;
    await vi.waitFor(() => expect(ws.listenerCount('message')).toBeGreaterThan(0));
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'audio',
          data: { audio: wavChunk(3200, 13).toString('base64') },
        }),
      ),
      false,
    );

    try {
      const first = await Promise.race([
        stream.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('WebSocket audio was buffered until completion')), 50),
        ),
      ]);
      expect(first.value?.frame.data[0]).toBe(13);
      ws.emit('message', Buffer.from(JSON.stringify({ type: 'complete' })), false);
      for await (const _audio of stream) {
        // Drain the stream after observing the incremental frame.
      }
    } finally {
      stream.close();
    }
  });

  it('maps REST timeout through connOptions', async () => {
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'rest' });
    const stream = tts.synthesize('hello', {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 20,
    });

    expect(Reflect.get(stream, 'timeoutMs')).toBe(20);
    stream.close();
  });

  it('maps WebSocket connection and receive timeout through connOptions', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'websocket' });
    const stream = tts.synthesize('hello', {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 200,
    });
    await vi.waitFor(() =>
      expect(wsState.instances.some((instance) => instance.options?.handshakeTimeout === 200)).toBe(
        true,
      ),
    );
    const ws = wsState.instances.find((instance) => instance.options?.handshakeTimeout === 200)!;
    await vi.waitFor(() => expect(ws.listenerCount('message')).toBeGreaterThan(0));

    expect(ws.options?.handshakeTimeout).toBe(200);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 200);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'complete' })), false);
    for await (const _audio of stream) {
      // Drain the completed stream.
    }
    timeoutSpy.mockRestore();
  });

  it('parses a REST WAV data chunk after ancillary RIFF chunks', async () => {
    const wav = wavWithJunkChunk(3200, 23);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(wav))),
    );
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'rest' });

    const frame = await tts.synthesize('hello').collect();

    expect(frame.data[0]).toBe(23);
    expect(frame.samplesPerChannel).toBe(1600);
  });

  it('parses a streaming WAV header split across SSE payloads', async () => {
    const wav = wavWithJunkChunk(3200, 29);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of [wav.subarray(0, 7), wav.subarray(7, 31), wav.subarray(31)]) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ audio: chunk.toString('base64') })}\n\n`,
            ),
          );
        }
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ is_final: true })}\n\n`),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'sse' });

    const frame = await tts.synthesize('hello').collect();

    expect(frame.data[0]).toBe(29);
    expect(frame.samplesPerChannel).toBe(1600);
  });

  it('decodes consecutive complete WAV payloads from one SSE response', async () => {
    const first = wavChunk(3200, 37);
    const second = wavChunk(3200, 41);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of [first, second]) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ audio: chunk.toString('base64') })}\n\n`,
            ),
          );
        }
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ is_final: true })}\n\n`),
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'sse' });

    const frame = await tts.synthesize('hello').collect();

    expect(frame.samplesPerChannel).toBe(3200);
    expect(frame.data[0]).toBe(37);
    expect(frame.data[1600]).toBe(41);
  });

  it('marks the actual exact-aligned WebSocket audio frame final', async () => {
    vi.useFakeTimers();
    const tts = new TTS({
      apiKey: 'test-key',
      synthesizeMethod: 'websocket',
      container: 'raw',
    });
    const stream = tts.synthesize('hello', {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 100,
    });
    const eventsPromise = (async () => {
      const events = [];
      for await (const event of stream) events.push(event);
      return events;
    })();
    await vi.advanceTimersByTimeAsync(0);
    const ws = wsState.instances.at(-1)!;

    ws.emit('message', Buffer.alloc(3200, 31), true);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'complete' })), false);
    await vi.advanceTimersByTimeAsync(0);
    const events = await eventsPromise;

    expect(events.every((event) => event.frame.samplesPerChannel > 0)).toBe(true);
    expect(events.reduce((sum, event) => sum + event.frame.samplesPerChannel, 0)).toBe(1600);
    expect(events.filter((event) => event.final)).toHaveLength(1);
    expect(events.at(-1)!.final).toBe(true);
  });

  it('closes a pending TTS WebSocket handshake when the stream aborts', async () => {
    vi.useFakeTimers();
    wsState.autoOpen = false;
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'websocket' });
    const stream = tts.synthesize('hello', {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    const ws = wsState.instances.at(-1)!;

    stream.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.closed).toBe(true);
    expect(ws.terminated).toBe(false);
  });

  it('closes a pending TTS WebSocket receive when the stream aborts', async () => {
    vi.useFakeTimers();
    const tts = new TTS({ apiKey: 'test-key', synthesizeMethod: 'websocket' });
    const stream = tts.synthesize('hello', {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    const ws = wsState.instances.at(-1)!;

    stream.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.closed).toBe(true);
    expect(ws.terminated).toBe(true);
    expect(ws.listenerCount('message')).toBe(0);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
  });

  it('removes receive listeners after WebSocket terminal completion', async () => {
    vi.useFakeTimers();
    const tts = new TTS({
      apiKey: 'test-key',
      synthesizeMethod: 'websocket',
      container: 'raw',
    });
    const stream = tts.synthesize('hello', {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    const ws = wsState.instances.at(-1)!;

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'complete' })), false);
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.listenerCount('message')).toBe(0);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
    expect(() => ws.emit('message', Buffer.alloc(3200), true)).not.toThrow();
    stream.close();
  });

  it('removes receive listeners after WebSocket provider error', async () => {
    vi.useFakeTimers();
    const tts = new TTS({
      apiKey: 'test-key',
      synthesizeMethod: 'websocket',
      container: 'raw',
    });
    tts.on('error', () => {});
    const stream = tts.synthesize('hello', {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    const ws = wsState.instances.at(-1)!;

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'error', message: 'failed' })), false);
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.listenerCount('message')).toBe(0);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
    expect(() => ws.emit('message', Buffer.alloc(3200), true)).not.toThrow();
    stream.close();
  });

  it('removes receive listeners after WebSocket timeout', async () => {
    vi.useFakeTimers();
    const tts = new TTS({
      apiKey: 'test-key',
      synthesizeMethod: 'websocket',
      container: 'raw',
    });
    tts.on('error', () => {});
    const stream = tts.synthesize('hello', {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    const ws = wsState.instances.at(-1)!;

    await vi.advanceTimersByTimeAsync(100);

    expect(ws.listenerCount('message')).toBe(0);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
    expect(() => ws.emit('message', Buffer.alloc(3200), true)).not.toThrow();
    stream.close();
  });
});

function wavChunk(pcmBytes: number, sample: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);
  const pcm = Buffer.alloc(pcmBytes);
  pcm.writeInt16LE(sample, 0);
  return Buffer.concat([header, pcm]);
}

function wavWithJunkChunk(pcmBytes: number, sample: number): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const junk = Buffer.alloc(12);
  junk.write('JUNK', 0);
  junk.writeUInt32LE(3, 4);
  junk.fill(9, 8, 11);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0);
  dataHeader.writeUInt32LE(pcmBytes, 4);
  const body = Buffer.concat([fmt, junk, dataHeader, Buffer.alloc(pcmBytes)]);
  body.writeInt16LE(sample, fmt.length + junk.length + dataHeader.length);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write('WAVE', 8);
  return Buffer.concat([riff, body]);
}
