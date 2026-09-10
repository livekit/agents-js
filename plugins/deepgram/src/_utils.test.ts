// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { HEARTBEAT_INTERVAL_MS, PONG_TIMEOUT_MS, startWebSocketHeartbeat } from './_utils.js';

class FakeSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  pings = 0;
  terminated = 0;

  ping() {
    this.pings++;
  }

  terminate() {
    this.terminated++;
    this.readyState = 3; // WebSocket.CLOSED
  }
}

const asWs = (socket: FakeSocket) => socket as unknown as WebSocket;

describe('startWebSocketHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('terminates a socket that stops answering pings', () => {
    const ws = new FakeSocket();
    const onTimeout = vi.fn();
    startWebSocketHeartbeat(asWs(ws), onTimeout);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(0); // still inside the pong window

    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(ws.terminated).toBe(1);
  });

  it('leaves a socket alone while pongs keep coming back', () => {
    const ws = new FakeSocket();
    startWebSocketHeartbeat(asWs(ws));

    // answer each ping before the next interval tick, so no deadline is ever
    // left outstanding across a tick
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      ws.emit('pong');
    }
    // and nothing fires afterwards either, since the last deadline was cleared
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);

    expect(ws.pings).toBe(3);
    expect(ws.terminated).toBe(0);
  });

  it('stops cleanly, cancelling a deadline that is already pending', () => {
    const ws = new FakeSocket();
    const stop = startWebSocketHeartbeat(asWs(ws));

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.pings).toBe(1); // a pong is now outstanding

    stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5);

    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(0);
    expect(ws.listenerCount('pong')).toBe(0);
  });

  it('does not ping a socket that is not open', () => {
    const ws = new FakeSocket();
    ws.readyState = 3; // WebSocket.CLOSED
    startWebSocketHeartbeat(asWs(ws));

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);

    expect(ws.pings).toBe(0);
  });
});
