// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError } from '@livekit/agents';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TTSDefaultVoiceId } from './models.js';
import { ChunkedStream, TTS, type TTSOptions } from './tts.js';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('node:https', () => ({
  request: requestMock,
}));

class TestChunkedStream extends ChunkedStream {
  runForTest() {
    return this.run();
  }
}

class MockRequest extends EventEmitter {
  #callback?: (res: EventEmitter & { statusCode: number; statusMessage: string }) => void;

  constructor(
    callback?: (res: EventEmitter & { statusCode: number; statusMessage: string }) => void,
  ) {
    super();
    this.#callback = callback;
  }

  write() {
    return true;
  }

  end() {
    if (!this.#callback) return;

    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      statusMessage: string;
    };
    res.statusCode = 401;
    res.statusMessage = 'Unauthorized';

    this.#callback(res);
    res.emit('data', Buffer.from(JSON.stringify({ error: 'invalid API key' })));
    res.emit('close');
    this.emit('close');
  }
}

describe('Cartesia ChunkedStream HTTP errors', () => {
  afterEach(() => {
    requestMock.mockReset();
  });

  it('rejects non-2xx responses instead of treating the body as audio', async () => {
    requestMock
      .mockImplementationOnce(() => new MockRequest())
      .mockImplementation((_options, callback) => new MockRequest(callback));

    const opts: TTSOptions = {
      model: 'sonic-3',
      encoding: 'pcm_s16le',
      sampleRate: 24000,
      voice: TTSDefaultVoiceId,
      apiKey: 'invalid-key',
      language: 'en',
      baseUrl: 'https://api.cartesia.ai',
      apiVersion: '2025-04-16',
      chunkTimeout: 5000,
      wordTimestamps: true,
    };
    const tts = new TTS(opts);
    const stream = new TestChunkedStream(tts, 'hi', opts, {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 1000,
    });

    await Promise.resolve();
    await expect(stream.runForTest()).rejects.toBeInstanceOf(APIConnectionError);
    await expect(stream.next()).resolves.toEqual({ value: undefined, done: true });
    stream.close();
  });
});
