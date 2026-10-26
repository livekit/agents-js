// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { WebSocket } from 'ws';
import { APITimeoutError } from './_exceptions.js';
import { DEFAULT_API_CONNECT_OPTIONS } from './types.js';

export interface WebSocketMonitorOptions {
  livenessTimeoutMs?: number;
}

/**
 * Probes an idle WebSocket and terminates it after bounded inbound silence.
 * Create one monitor per active connection; outbound traffic does not reset its deadline.
 */
export class WebSocketMonitor {
  readonly #ws: WebSocket;
  readonly #livenessTimeoutMs: number;
  readonly #pingIntervalMs: number;
  #lastReceived = performance.now();
  #pingSent = false;
  #timer?: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(ws: WebSocket, options: WebSocketMonitorOptions = {}) {
    this.#ws = ws;
    this.#livenessTimeoutMs =
      options.livenessTimeoutMs ?? DEFAULT_API_CONNECT_OPTIONS.livenessTimeoutMs;
    if (!Number.isFinite(this.#livenessTimeoutMs) || this.#livenessTimeoutMs <= 0) {
      throw new RangeError('livenessTimeoutMs must be a finite number greater than 0');
    }
    this.#pingIntervalMs = this.#livenessTimeoutMs / 3;

    ws.on('message', this.#onActivity);
    ws.on('ping', this.#onActivity);
    ws.on('pong', this.#onActivity);
    ws.once('close', this.close);
    this.#schedule(this.#pingIntervalMs);
  }

  #onActivity = (): void => {
    if (this.#closed) return;
    this.#lastReceived = performance.now();
    this.#pingSent = false;
    this.#schedule(this.#pingIntervalMs);
  };

  #schedule(delayMs: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(this.#check, delayMs);
    this.#timer.unref?.();
  }

  #check = (): void => {
    if (this.#closed) return;
    const elapsed = performance.now() - this.#lastReceived;
    if (!this.#pingSent && elapsed >= this.#pingIntervalMs) {
      this.#pingSent = true;
      try {
        this.#ws.ping();
      } catch (error) {
        this.#ws.emit(
          'error',
          error instanceof Error
            ? error
            : new APITimeoutError({ message: 'WebSocket ping failed' }),
        );
        this.#ws.terminate();
        this.close();
        return;
      }
      this.#schedule(Math.max(1, this.#livenessTimeoutMs - elapsed));
      return;
    }

    if (elapsed >= this.#livenessTimeoutMs) {
      const error = new APITimeoutError({
        message: `No WebSocket messages received for ${this.#livenessTimeoutMs}ms`,
      });
      if (this.#ws.listenerCount('error') > 0) this.#ws.emit('error', error);
      this.#ws.terminate();
      this.close();
      return;
    }
    this.#schedule(Math.max(1, this.#livenessTimeoutMs - elapsed));
  };

  close = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#ws.off('message', this.#onActivity);
    this.#ws.off('ping', this.#onActivity);
    this.#ws.off('pong', this.#onActivity);
    this.#ws.off('close', this.close);
  };
}
