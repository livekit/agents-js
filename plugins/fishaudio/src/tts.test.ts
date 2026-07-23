// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS, tts } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts as testTts } from '@livekit/agents-plugins-test';
import { decode, encode } from '@msgpack/msgpack';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

const httpsBoundary = vi.hoisted<{ payloads: Uint8Array[] }>(() => ({ payloads: [] }));

vi.mock('node:https', () => {
  class TestEmitter {
    readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();

    on(event: string, handler: (...args: unknown[]) => void): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  return {
    request: (
      _options: unknown,
      callback: (response: TestEmitter & { statusCode: number }) => void,
    ) => {
      const request = new TestEmitter();
      let payload = new Uint8Array();
      return Object.assign(request, {
        write: (chunk: Uint8Array) => {
          payload = new Uint8Array(chunk);
        },
        end: () => {
          httpsBoundary.payloads.push(payload);
          const response = Object.assign(new TestEmitter(), { statusCode: 200 });
          callback(response);
          queueMicrotask(() => response.emit('close'));
        },
      });
    },
  };
});

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for promise')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function startSynthesis(wss: WebSocketServer) {
  const stopReceived = new Promise<WebSocket>((resolve) => {
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
        if (message.event === 'stop') resolve(ws);
      });
    });
  });

  const fishAudio = new TTS({
    apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
  });
  const stream = fishAudio.stream();
  stream.pushText('hello world.');
  stream.endInput();

  return { fishAudio, stream, ws: await waitFor(stopReceived) };
}

async function synthesizeTurn(
  fishAudio: TTS,
  text: string,
  connOptions?: APIConnectOptions,
): Promise<tts.SynthesizedAudio[]> {
  const stream = fishAudio.stream({ connOptions });
  stream.pushText(text);
  stream.endInput();

  try {
    const events: tts.SynthesizedAudio[] = [];
    for await (const event of stream) {
      if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
    }
    return events;
  } finally {
    stream.close();
  }
}

async function captureStartRequest(
  opts: ConstructorParameters<typeof TTS>[0] = {},
  update?: (fishAudio: TTS) => void,
): Promise<Record<string, unknown>> {
  const { wss, baseURL } = await startWebSocketServer();
  const startRequest = new Promise<Record<string, unknown>>((resolve) => {
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
        if (message.event === 'start') {
          resolve(message.request as Record<string, unknown>);
        } else if (message.event === 'stop') {
          ws.send(encode({ event: 'finish', reason: 'stop' }));
        }
      });
    });
  });

  const fishAudio = new TTS({ apiKey: 'test-key', baseURL, ...opts });
  update?.(fishAudio);
  const stream = fishAudio.stream();
  const drain = (async () => {
    for await (const _event of stream) {
      // Drain the stream so its tasks finish before cleanup.
    }
  })();

  try {
    stream.pushText('hello world.');
    stream.endInput();
    const request = await waitFor(startRequest);
    await waitFor(drain);
    return request;
  } finally {
    stream.close();
    await fishAudio.close();
    await closeWebSocketServer(wss);
  }
}

const hasFishAudioConfig = Boolean(process.env.FISH_API_KEY && process.env.OPENAI_API_KEY);

if (hasFishAudioConfig) {
  describe('FishAudio', async () => {
    await testTts(new TTS(), new STT({ useRealtime: false }));
  });
} else {
  describe('FishAudio', () => {
    it.skip('requires FISH_API_KEY and OPENAI_API_KEY', () => {});
  });
}

describe('FishAudio streaming', () => {
  it('keeps sampling and encoding defaults unchanged', async () => {
    const request = await captureStartRequest();
    expect(request.temperature).toBe(0.7);
    expect(request.top_p).toBe(0.7);
    expect(request.mp3_bitrate).toBe(64);
    expect(request.opus_bitrate).toBe(64000);
    expect(request.normalize).toBe(true);
  });

  it('sets sampling and encoding params from the constructor', async () => {
    const request = await captureStartRequest({
      temperature: 0.3,
      topP: 0.9,
      mp3Bitrate: 192,
      opusBitrate: 32000,
      normalize: false,
    });
    expect(request.temperature).toBe(0.3);
    expect(request.top_p).toBe(0.9);
    expect(request.mp3_bitrate).toBe(192);
    expect(request.opus_bitrate).toBe(32000);
    expect(request.normalize).toBe(false);
  });

  it('sets sampling and encoding params from updateOptions', async () => {
    const request = await captureStartRequest({}, (fishAudio) => {
      fishAudio.updateOptions({
        temperature: 0.5,
        topP: 0.8,
        mp3Bitrate: 128,
        opusBitrate: -1000,
        normalize: false,
      });
    });
    expect(request.temperature).toBe(0.5);
    expect(request.top_p).toBe(0.8);
    expect(request.mp3_bitrate).toBe(128);
    expect(request.opus_bitrate).toBe(-1000);
    expect(request.normalize).toBe(false);
  });

  it('sets normalizeLoudness in prosody', async () => {
    const request = await captureStartRequest({ normalizeLoudness: false });
    expect(request.prosody).toEqual({ normalize_loudness: false });
  });

  it('sets normalizeLoudness with speed and volume', async () => {
    const request = await captureStartRequest({
      speed: 1.2,
      volume: -3.0,
      normalizeLoudness: true,
    });
    expect(request.prosody).toEqual({
      speed: 1.2,
      volume: -3.0,
      normalize_loudness: true,
    });
  });

  it('omits generation tuning by default', async () => {
    const request = await captureStartRequest();
    expect(request).not.toHaveProperty('max_new_tokens');
    expect(request).not.toHaveProperty('min_chunk_length');
    expect(request).not.toHaveProperty('condition_on_previous_chunks');
    expect(request).not.toHaveProperty('early_stop_threshold');
  });

  it('sets generation tuning params from the constructor', async () => {
    const request = await captureStartRequest({
      maxNewTokens: 512,
      minChunkLength: 25,
      conditionOnPreviousChunks: false,
      earlyStopThreshold: 0.8,
    });
    expect(request.max_new_tokens).toBe(512);
    expect(request.min_chunk_length).toBe(25);
    expect(request.condition_on_previous_chunks).toBe(false);
    expect(request.early_stop_threshold).toBe(0.8);
  });

  it('sets generation tuning params from updateOptions', async () => {
    const request = await captureStartRequest({}, (fishAudio) => {
      fishAudio.updateOptions({
        maxNewTokens: 2048,
        minChunkLength: 30,
        conditionOnPreviousChunks: false,
        earlyStopThreshold: 0.5,
        normalizeLoudness: false,
      });
    });
    expect(request.max_new_tokens).toBe(2048);
    expect(request.min_chunk_length).toBe(30);
    expect(request.condition_on_previous_chunks).toBe(false);
    expect(request.early_stop_threshold).toBe(0.5);
    expect(request.prosody).toEqual({ normalize_loudness: false });
  });

  it('snapshots options when each stream is constructed', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const requests: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
        if (message.event === 'start') {
          requests.push(message.request as Record<string, unknown>);
        } else if (message.event === 'stop') {
          ws.send(encode({ event: 'finish', reason: 'stop' }));
        }
      });
    });

    const fishAudio = new TTS({
      apiKey: 'test-key',
      baseURL,
      temperature: 0.2,
      topP: 0.3,
      normalize: false,
    });
    const streamA = fishAudio.stream();
    fishAudio.updateOptions({ temperature: 0.8, topP: 0.9, normalize: true });
    const streamB = fishAudio.stream();

    try {
      for (const [stream, text] of [
        [streamA, 'stream A.'],
        [streamB, 'stream B.'],
      ] as const) {
        stream.pushText(text);
        stream.endInput();
        for await (const _event of stream) {
          // Drain each stream so its tasks finish before checking the requests.
        }
      }

      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        temperature: 0.2,
        top_p: 0.3,
        normalize: false,
      });
      expect(requests[1]).toMatchObject({
        temperature: 0.8,
        top_p: 0.9,
        normalize: true,
      });
    } finally {
      streamA.close();
      streamB.close();
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('snapshots options for each chunked HTTP request at construction', async () => {
    httpsBoundary.payloads.length = 0;
    const fishAudio = new TTS({
      apiKey: 'test-key',
      baseURL: 'https://fish.test',
      temperature: 0.2,
      topP: 0.3,
      mp3Bitrate: 64,
      opusBitrate: 24000,
      normalize: false,
    });
    const streamA = fishAudio.synthesize('stream A.');
    fishAudio.updateOptions({
      temperature: 0.8,
      topP: 0.9,
      mp3Bitrate: 192,
      opusBitrate: 64000,
      normalize: true,
    });
    const streamB = fishAudio.synthesize('stream B.');

    try {
      for (const stream of [streamA, streamB]) {
        for await (const _event of stream) {
          // Drain each stream so its HTTP request finishes before assertions.
        }
      }

      expect(httpsBoundary.payloads).toHaveLength(2);
      expect(decode(httpsBoundary.payloads[0]!)).toMatchObject({
        text: 'stream A.',
        format: 'pcm',
        temperature: 0.2,
        top_p: 0.3,
        mp3_bitrate: 64,
        opus_bitrate: 24000,
        normalize: false,
      });
      expect(decode(httpsBoundary.payloads[1]!)).toMatchObject({
        text: 'stream B.',
        format: 'pcm',
        temperature: 0.8,
        top_p: 0.9,
        mp3_bitrate: 192,
        opus_bitrate: 64000,
        normalize: true,
      });
    } finally {
      streamA.close();
      streamB.close();
      await fishAudio.close();
    }
  });

  it('validates temperature and topP', async () => {
    expect(() => new TTS({ apiKey: 'test-key', temperature: 1.5 })).toThrow(
      'temperature must be between 0 and 1',
    );
    expect(() => new TTS({ apiKey: 'test-key', topP: -0.1 })).toThrow(
      'topP must be between 0 and 1',
    );

    const fishAudio = new TTS({ apiKey: 'test-key' });
    try {
      expect(() => fishAudio.updateOptions({ temperature: 1.5 })).toThrow(
        'temperature must be between 0 and 1',
      );
      expect(() => fishAudio.updateOptions({ topP: -0.1 })).toThrow('topP must be between 0 and 1');
    } finally {
      await fishAudio.close();
    }
  });

  it('validates generation tuning params', async () => {
    expect(() => new TTS({ apiKey: 'test-key', maxNewTokens: -1 })).toThrow(
      'maxNewTokens must be non-negative',
    );
    expect(() => new TTS({ apiKey: 'test-key', minChunkLength: 150 })).toThrow(
      'minChunkLength must be between 0 and 100',
    );
    expect(() => new TTS({ apiKey: 'test-key', earlyStopThreshold: 1.5 })).toThrow(
      'earlyStopThreshold must be between 0 and 1',
    );

    const fishAudio = new TTS({ apiKey: 'test-key' });
    try {
      expect(() => fishAudio.updateOptions({ maxNewTokens: -1 })).toThrow(
        'maxNewTokens must be non-negative',
      );
      expect(() => fishAudio.updateOptions({ minChunkLength: -5 })).toThrow(
        'minChunkLength must be between 0 and 100',
      );
      expect(() => fishAudio.updateOptions({ earlyStopThreshold: -0.1 })).toThrow(
        'earlyStopThreshold must be between 0 and 1',
      );
    } finally {
      await fishAudio.close();
    }
  });

  it('drops normalizeLoudness on the s1 constructor', async () => {
    const request = await captureStartRequest({ model: 's1', normalizeLoudness: true });
    expect(request.prosody).toBeNull();
  });

  it('drops normalizeLoudness on s1 updateOptions', async () => {
    const request = await captureStartRequest({ model: 's1' }, (fishAudio) => {
      fishAudio.updateOptions({ normalizeLoudness: true });
    });
    expect(request.prosody).toBeNull();
  });

  it('drops normalizeLoudness when switching to s1', async () => {
    const request = await captureStartRequest(
      { model: 's2-pro', normalizeLoudness: true },
      (fishAudio) => {
        fishAudio.updateOptions({ model: 's1' });
      },
    );
    expect(request.prosody).toBeNull();
  });

  it('keeps normalizeLoudness on the s2 pro family', async () => {
    for (const model of ['s2-pro', 's2.1-pro'] as const) {
      const request = await captureStartRequest({ model, normalizeLoudness: false });
      expect(request.prosody).toEqual({ normalize_loudness: false });
    }
  });

  it('reuses one websocket across sequential turns', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let connectionCount = 0;

    wss.on('connection', (ws) => {
      connectionCount++;
      ws.on('message', (raw) => {
        const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
        if (message.event === 'stop') {
          ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));
          ws.send(encode({ event: 'finish', reason: 'stop' }));
        }
      });
    });

    const fishAudio = new TTS({ apiKey: 'test-key', baseURL });
    try {
      expect(await synthesizeTurn(fishAudio, 'first turn.')).not.toHaveLength(0);
      expect(await synthesizeTurn(fishAudio, 'second turn.')).not.toHaveLength(0);
      expect(connectionCount).toBe(1);
    } finally {
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('prewarms and reuses the ready websocket', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let connectionCount = 0;
    const connected = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        connectionCount++;
        resolve();
        ws.on('message', (raw) => {
          const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
          if (message.event === 'stop') {
            ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));
            ws.send(encode({ event: 'finish', reason: 'stop' }));
          }
        });
      });
    });

    const fishAudio = new TTS({ apiKey: 'test-key', baseURL });
    try {
      fishAudio.prewarm();
      await waitFor(connected);
      expect(await synthesizeTurn(fishAudio, 'prewarmed turn.')).not.toHaveLength(0);
      expect(connectionCount).toBe(1);
    } finally {
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('opens a websocket with the updated model after model changes', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const models: string[] = [];

    wss.on('connection', (ws, request) => {
      const model = request.headers.model;
      if (typeof model === 'string') models.push(model);
      ws.on('message', (raw) => {
        const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
        if (message.event === 'stop') {
          ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));
          ws.send(encode({ event: 'finish', reason: 'stop' }));
        }
      });
    });

    const fishAudio = new TTS({ apiKey: 'test-key', baseURL, model: 's2-pro' });
    try {
      await synthesizeTurn(fishAudio, 'old model.');
      fishAudio.updateOptions({ model: 's2.1-pro' });
      await synthesizeTurn(fishAudio, 'new model.');
      expect(models).toEqual(['s2-pro', 's2.1-pro']);
    } finally {
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('reconnects with the new model when an in-flight prewarm becomes stale', async () => {
    let approveFirstUpgrade: (() => void) | undefined;
    let firstUpgradeStarted: (() => void) | undefined;
    const firstUpgrade = new Promise<void>((resolve) => {
      firstUpgradeStarted = resolve;
    });
    let upgradeCount = 0;
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, approve) => {
        upgradeCount++;
        if (upgradeCount === 1) {
          approveFirstUpgrade = () => approve(true);
          firstUpgradeStarted?.();
          return;
        }
        approve(true);
      },
    });
    await once(wss, 'listening');
    const address = wss.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected websocket server to listen on a TCP port');
    }
    const models: string[] = [];
    wss.on('connection', (ws, request) => {
      const model = request.headers.model;
      if (typeof model === 'string') models.push(model);
      ws.on('message', (raw) => {
        const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
        if (message.event === 'stop') {
          ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));
          ws.send(encode({ event: 'finish', reason: 'stop' }));
        }
      });
    });

    const fishAudio = new TTS({
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${address.port}`,
      model: 's2-pro',
    });
    try {
      fishAudio.prewarm();
      await waitFor(firstUpgrade);
      fishAudio.updateOptions({ model: 's2.1-pro' });
      approveFirstUpgrade?.();
      expect(await synthesizeTurn(fishAudio, 'new model.')).not.toHaveLength(0);
      expect(models).toEqual(['s2-pro', 's2.1-pro']);
    } finally {
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('discards a failed websocket before the next turn', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let connectionCount = 0;

    wss.on('connection', (ws) => {
      connectionCount++;
      const connectionNumber = connectionCount;
      ws.on('message', (raw) => {
        const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
        if (message.event !== 'stop') return;
        if (connectionNumber === 1) {
          ws.close(1011, 'provider failure');
          return;
        }
        ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));
        ws.send(encode({ event: 'finish', reason: 'stop' }));
      });
    });

    const fishAudio = new TTS({ apiKey: 'test-key', baseURL });
    try {
      expect(
        await synthesizeTurn(fishAudio, 'failing turn.', {
          ...DEFAULT_API_CONNECT_OPTIONS,
          maxRetry: 0,
        }),
      ).toHaveLength(0);
      expect(await synthesizeTurn(fishAudio, 'recovery turn.')).not.toHaveLength(0);
      expect(connectionCount).toBe(2);
    } finally {
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('replaces a websocket that closed while idle', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let connectionCount = 0;
    let firstConnectionClosed: (() => void) | undefined;
    const firstClosed = new Promise<void>((resolve) => {
      firstConnectionClosed = resolve;
    });

    wss.on('connection', (ws) => {
      connectionCount++;
      const connectionNumber = connectionCount;
      ws.on('close', () => {
        if (connectionNumber === 1) firstConnectionClosed?.();
      });
      ws.on('message', (raw) => {
        const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
        if (message.event !== 'stop') return;
        ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));
        ws.send(encode({ event: 'finish', reason: 'stop' }));
        if (connectionNumber === 1) setTimeout(() => ws.close(), 10);
      });
    });

    const fishAudio = new TTS({ apiKey: 'test-key', baseURL });
    try {
      expect(await synthesizeTurn(fishAudio, 'first turn.')).not.toHaveLength(0);
      await waitFor(firstClosed);
      expect(await waitFor(synthesizeTurn(fishAudio, 'second turn.'))).not.toHaveLength(0);
      expect(connectionCount).toBe(2);
    } finally {
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('closes a pooled websocket when the TTS closes', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const closed = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('close', () => resolve());
        ws.on('message', (raw) => {
          const message = decode(Buffer.from(raw as ArrayBuffer)) as Record<string, unknown>;
          if (message.event === 'stop') {
            ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));
            ws.send(encode({ event: 'finish', reason: 'stop' }));
          }
        });
      });
    });

    const fishAudio = new TTS({ apiKey: 'test-key', baseURL });
    try {
      await synthesizeTurn(fishAudio, 'closing turn.');
      await fishAudio.close();
      await waitFor(closed);
      expect(wss.clients.size).toBe(0);
    } finally {
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('emits the first complete frame before the next provider event', async () => {
    const { wss } = await startWebSocketServer();
    const { fishAudio, stream, ws } = await startSynthesis(wss);

    try {
      ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));

      const first = await waitFor(stream.next());
      expect(first.done).toBe(false);
      expect(first.value).not.toBe(tts.SynthesizeStream.END_OF_STREAM);
      if (first.value !== tts.SynthesizeStream.END_OF_STREAM) {
        expect(first.value.frame.samplesPerChannel).toBe(2400);
        expect(first.value.final).toBe(false);
      }

      ws.send(encode({ event: 'finish', reason: 'stop' }));
      for await (const _event of stream) {
        // Drain the stream so its tasks finish before cleanup.
      }
    } finally {
      stream.close();
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });

  it('marks the terminal frame final before ending the stream', async () => {
    const { wss } = await startWebSocketServer();
    const { fishAudio, stream, ws } = await startSynthesis(wss);

    try {
      ws.send(encode({ event: 'audio', audio: Buffer.alloc(4800) }));
      ws.send(encode({ event: 'finish', reason: 'stop' }));

      const events: tts.SynthesizedAudio[] = [];
      for await (const event of stream) {
        if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.final).toBe(true);
    } finally {
      stream.close();
      await fishAudio.close();
      await closeWebSocketServer(wss);
    }
  });
});
