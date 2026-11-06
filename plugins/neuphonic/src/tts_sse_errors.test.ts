// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_API_CONNECT_OPTIONS } from '@livekit/agents';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TTS } from './tts.js';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('node:https', () => ({ request: requestMock }));

describe('Neuphonic SSE errors', () => {
  it.each([
    ['provider rejection', 'data: {"status_code":401,"errors":["invalid API key"]}\n'],
    ['invalid JSON', 'data: {invalid}\n'],
  ])('surfaces %s through the TTS error event', async (_name, message) => {
    const response = new EventEmitter();
    const request = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(() => request.emit('close')),
    });
    let respond: ((response: EventEmitter) => void) | undefined;
    requestMock.mockImplementation((_options, callback) => {
      respond = callback;
      return request;
    });
    const tts = new TTS({ apiKey: 'test' });
    const onError = vi.fn();
    tts.on('error', onError);
    const stream = tts.synthesize('Hello', { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 });
    const consume = (async () => {
      const frames = [];
      for await (const frame of stream) frames.push(frame);
      return frames;
    })();
    try {
      await vi.waitFor(() => expect(respond).toBeTypeOf('function'));
      respond!(response);
      expect(() => response.emit('data', Buffer.from(message))).not.toThrow();
      expect(() => response.emit('close')).not.toThrow();
      expect(await consume).toEqual([]);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]![0].error).toBeInstanceOf(Error);
      expect(request.destroy).toHaveBeenCalledOnce();
    } finally {
      request.emit('close');
      stream.close();
      await consume;
      requestMock.mockReset();
    }
  });
});
