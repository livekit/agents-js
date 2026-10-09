// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { WebSocket } from 'ws';

export class PeriodicCollector<T> {
  private duration: number;
  private callback: (value: T) => void;
  private lastFlushTime: number;
  private total: T | null = null;

  constructor(callback: (value: T) => void, options: { duration: number }) {
    /**
     * Create a new periodic collector that accumulates values and calls the callback
     * after the specified duration if there are values to report.
     *
     * @param callback Function to call with accumulated value when duration expires
     * @param options.duration Time in seconds between callback invocations
     */
    this.duration = options.duration;
    this.callback = callback;
    this.lastFlushTime = performance.now() / 1000; // Convert to seconds
  }

  push(value: T): void {
    /**
     * Add a value to the accumulator
     */
    if (this.total === null) {
      this.total = value;
    } else {
      // Type assertion needed for generic addition
      this.total = (this.total as any) + (value as any);
    }

    if (performance.now() / 1000 - this.lastFlushTime >= this.duration) {
      this.flush();
    }
  }

  flush(): void {
    /**
     * Force callback to be called with current total if non-zero
     */
    if (this.total !== null) {
      this.callback(this.total);
      this.total = null;
    }
    this.lastFlushTime = performance.now() / 1000;
  }
}

/** How often to ping an idle socket. Matches `heartbeat=30.0` in the Python plugin. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** How long to wait for the pong before giving up, as aiohttp does, at half the interval. */
export const PONG_TIMEOUT_MS = 15_000;

/**
 * Detect a socket that has gone away silently.
 *
 * Node's `ws` never pings on its own, so a half-open connection (no FIN, no RST) is
 * invisible to the plugin: `send()` keeps buffering, no `close` or `error` is ever
 * emitted, and a reconnect loop driven by those events never runs. Ping on an
 * interval and terminate the socket when the pong does not come back, which emits
 * `close` and lets the caller's existing reconnect path take over.
 *
 * Terminate rather than close: a close handshake needs a peer that is still
 * listening, which by definition this one is not.
 *
 * @returns a function that stops the heartbeat. Call it when tearing the socket down.
 */
export function startWebSocketHeartbeat(ws: WebSocket, onTimeout?: () => void): () => void {
  let pongDeadline: NodeJS.Timeout | undefined;

  const clearDeadline = () => {
    if (pongDeadline) {
      clearTimeout(pongDeadline);
      pongDeadline = undefined;
    }
  };

  const onPong = () => clearDeadline();
  ws.on('pong', onPong);

  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (pongDeadline) return; // a ping is already outstanding

    try {
      ws.ping();
    } catch {
      return; // the socket is already gone; `close` will have been emitted
    }

    pongDeadline = setTimeout(() => {
      pongDeadline = undefined;
      onTimeout?.();
      ws.terminate();
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);

  return () => {
    clearInterval(interval);
    clearDeadline();
    ws.off('pong', onPong);
  };
}
