// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTS, type TTSOptions } from './tts.js';

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = 0;
    readonly sent: unknown[] = [];
    readonly #listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor(
      readonly url: string,
      readonly options: unknown,
    ) {
      MockWebSocket.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = this.#listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
      listeners.add(listener);
      this.#listeners.set(event, listeners);
      return this;
    }

    off(event: string, listener: (...args: unknown[]) => void) {
      this.#listeners.get(event)?.delete(listener);
      return this;
    }

    send(data: unknown): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', 1000, Buffer.from(''));
    }

    terminate(): void {
      this.readyState = MockWebSocket.CLOSED;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.#listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  return { MockWebSocket };
});

vi.mock('ws', () => ({ default: MockWebSocket, WebSocket: MockWebSocket }));

initializeLogger({ pretty: false, level: 'silent' });

const hasRimeConfig = Boolean(process.env.RIME_API_KEY && process.env.OPENAI_API_KEY);

function pcmChunk(byteLength: number): Uint8Array {
  const chunk = new Uint8Array(byteLength);
  for (let i = 0; i < chunk.length; i += 2) {
    chunk[i] = 1;
  }
  return chunk;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('condition not met within timeout');
    }
    await sleep(5);
  }
}

async function captureFetchPayload(opts: Partial<TTSOptions>): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      },
    );
  });

  const rimeTTS = new TTS({
    apiKey: 'test-rime-key',
    baseURL: 'https://rime.test/v1/rime-tts',
    modelId: 'arcana',
    speaker: 'luna',
    ...opts,
  });

  const result = await withTimeout(rimeTTS.synthesize('Hello from Rime.').next(), 1000);
  expect(result).not.toBe('timeout');
  expect(payload).toBeDefined();
  return payload!;
}

beforeEach(() => {
  MockWebSocket.instances.length = 0;
});

describe('Rime TTS streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits audio before the Rime response body closes', async () => {
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    );

    const rimeTTS = new TTS({
      apiKey: 'test-rime-key',
      baseURL: 'https://rime.test/v1/rime-tts',
      modelId: 'arcana',
      speaker: 'luna',
      samplingRate: 16000,
    });

    const stream = rimeTTS.synthesize('This should stream before the response ends.');
    const firstAudio = stream.next();

    bodyController.enqueue(pcmChunk(3200));
    bodyController.enqueue(pcmChunk(3200));

    const firstResult = await withTimeout(firstAudio, 1000);
    expect(firstResult).not.toBe('timeout');
    if (firstResult === 'timeout') return;

    expect(firstResult.done).toBe(false);
    expect(firstResult.value.final).toBe(false);
    expect(firstResult.value.frame.samplesPerChannel).toBe(1600);

    bodyController.close();

    const finalResult = await stream.next();
    expect(finalResult.done).toBe(false);
    expect(finalResult.value.final).toBe(true);

    const doneResult = await stream.next();
    expect(doneResult.done).toBe(true);
  });
});

describe('Rime TTS language options', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends language instead of lang in one-shot payloads', async () => {
    const payload = await captureFetchPayload({ language: 'eng', lang: 'spa' });

    expect(payload.language).toBe('eng');
    expect(payload).not.toHaveProperty('lang');
  });

  it('maps legacy lang to the Rime language API parameter', async () => {
    const payload = await captureFetchPayload({ lang: 'spa' });

    expect(payload.language).toBe('spa');
    expect(payload).not.toHaveProperty('lang');
  });

  it('sends language instead of lang in WebSocket query parameters', async () => {
    const rimeTTS = new TTS({
      apiKey: 'test-rime-key',
      baseURL: 'wss://rime.test',
      useWebsocket: true,
      modelId: 'arcana',
      speaker: 'luna',
      language: 'eng',
      lang: 'spa',
    });
    const stream = rimeTTS.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
    });

    try {
      await waitFor(() => MockWebSocket.instances.length > 0);
      const socket = MockWebSocket.instances[0]!;
      const url = new URL(socket.url);

      expect(url.searchParams.get('language')).toBe('eng');
      expect(url.searchParams.has('lang')).toBe(false);
    } finally {
      stream.close();
      await withTimeout(stream.next(), 1000);
    }
  });
});

if (hasRimeConfig) {
  describe('Rime TTS', async () => {
    await tts(new TTS(), new STT(), { streaming: false });
  });
} else {
  describe('Rime TTS', () => {
    it.skip('requires RIME_API_KEY and OPENAI_API_KEY', () => {});
  });
}
