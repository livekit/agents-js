// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, initializeLogger } from '@livekit/agents';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTS } from './tts.js';

const wsState = vi.hoisted(() => ({
  instances: [] as Array<{ sentMessages: string[] }>,
}));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');

  class MockWebSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    binaryType = 'nodebuffer' as const;
    sentMessages: string[] = [];

    constructor(_url: string) {
      super();
      wsState.instances.push(this as unknown as { sentMessages: string[] });

      setTimeout(() => {
        this.readyState = MockWebSocket.OPEN;
        this.emit('open');
        setTimeout(() => {
          this.emit('message', JSON.stringify({ type: 'successful-connection' }), false);
        }, 0);
      }, 0);
    }

    send(data: string) {
      this.sentMessages.push(data);
      const payload = JSON.parse(data) as { token?: string; query?: string };

      if (payload.token) {
        setTimeout(() => {
          this.emit('message', JSON.stringify({ type: 'successful-authentication' }), false);
        }, 0);
        return;
      }

      if (payload.query) {
        setTimeout(() => {
          this.emit('error', new Error('mid-stream socket failure'));
        }, 0);
      }
    }

    close() {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }

    terminate() {
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  return { default: MockWebSocket };
});

type TimeoutCallback = (...args: unknown[]) => unknown;

async function withHandledTimeoutRejections<T>(fn: () => Promise<T>): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(
      ((...handlerArgs: unknown[]) => {
        if (typeof handler !== 'function') {
          return;
        }

        const result = (handler as TimeoutCallback)(...handlerArgs);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).catch(() => undefined);
        }
      }) as TimerHandler,
      timeout,
      ...(args as []),
    )) as typeof setTimeout;

  try {
    return await fn();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

describe('SynthesizeStream retry behavior', () => {
  beforeEach(() => {
    wsState.instances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not retry a websocket failure after input has been consumed', async () => {
    const ttsInstance = new TTS({ authToken: 'tok', apiUrl: 'http://tts:8080' });
    const errors: Error[] = [];
    ttsInstance.on('error', (event) => {
      errors.push(event.error);
    });

    await withHandledTimeoutRejections(async () => {
      const stream = ttsInstance.stream({
        connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
      });

      stream.pushText('hello from blaze');
      stream.endInput();

      for await (const _ of stream) {
        // consume stream until it closes after the error path
      }
    });

    expect(wsState.instances).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(APIConnectionError);
    expect((errors[0] as APIConnectionError).message).toContain('mid-stream socket failure');
    expect((errors[0] as APIConnectionError).retryable).toBe(false);
  });
});
