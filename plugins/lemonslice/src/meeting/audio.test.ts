// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { streamMeetingRelay } from './audio.js';

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeWebSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    closeCalls = 0;

    constructor(readonly url: string) {
      super();
      FakeWebSocket.instances.push(this);
    }

    close(): void {
      this.closeCalls += 1;
    }
  }

  return { WebSocket: FakeWebSocket, default: FakeWebSocket };
});

interface FakeWebSocket {
  url: string;
  readyState: number;
  closeCalls: number;
  listenerCount(event: string): number;
  emit(event: string, ...args: unknown[]): boolean;
}

const FakeWs = WebSocket as unknown as {
  CONNECTING: number;
  OPEN: number;
  instances: FakeWebSocket[];
};

describe('streamMeetingRelay', () => {
  beforeEach(() => {
    initializeLogger({ pretty: false });
    FakeWs.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps an error listener installed when aborting a CONNECTING socket', async () => {
    const stop = new AbortController();
    const task = streamMeetingRelay('ws://relay.test', () => {}, { stop: stop.signal });

    const ws = FakeWs.instances[0]!;
    expect(ws.readyState).toBe(FakeWs.CONNECTING);

    stop.abort();
    await task;

    expect(ws.closeCalls).toBe(1);
    // The real ws emits 'error' when a CONNECTING socket is closed; without a
    // listener the emit throws and crashes the process.
    expect(ws.listenerCount('error')).toBeGreaterThan(0);
    expect(() =>
      ws.emit('error', new Error('WebSocket was closed before the connection was established')),
    ).not.toThrow();
  });

  it('aborting during reconnect backoff resolves immediately and clears the timer', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const task = streamMeetingRelay('ws://relay.test', () => {}, {
      stop: stop.signal,
      reconnectDelayMs: 30_000,
    });

    const ws = FakeWs.instances[0]!;
    ws.readyState = FakeWs.OPEN;
    ws.emit('open');
    ws.emit('close');

    // let the loop enter the backoff wait
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    stop.abort();
    await task;

    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    expect(FakeWs.instances).toHaveLength(1);
  });

  it('removes the backoff abort listener when the timer fires and reconnects', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const task = streamMeetingRelay('ws://relay.test', () => {}, {
      stop: stop.signal,
      reconnectDelayMs: 1_000,
    });

    const first = FakeWs.instances[0]!;
    first.readyState = FakeWs.OPEN;
    first.emit('open');
    first.emit('close');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWs.instances).toHaveLength(2);
    // only the new connection's abort listener remains; the backoff listener
    // must have been removed when its timer fired
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(1);

    stop.abort();
    await task;
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });
});
