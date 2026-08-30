// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { waitForWebSocketOpen } from '@livekit/agents';
import { WebSocket } from 'ws';

export class PeriodicCollector<T> {
  private duration: number;
  private callback: (value: T) => void;
  private lastFlushTime: number;
  private total: T | null = null;

  constructor(callback: (value: T) => void, options: { duration: number }) {
    this.duration = options.duration;
    this.callback = callback;
    this.lastFlushTime = performance.now() / 1000;
  }

  push(value: T): void {
    if (this.total === null) {
      this.total = value;
    } else {
      this.total = (this.total as any) + (value as any);
    }

    if (performance.now() / 1000 - this.lastFlushTime >= this.duration) {
      this.flush();
    }
  }

  flush(): void {
    if (this.total !== null) {
      this.callback(this.total);
      this.total = null;
    }
    this.lastFlushTime = performance.now() / 1000;
  }
}

export const connectWebSocket = async ({
  url,
  headers,
  timeoutMs,
}: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<WebSocket> => {
  const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs });

  try {
    await waitForWebSocketOpen(ws, 'xAI');
    return ws;
  } catch (e) {
    try {
      ws.on('error', () => {});
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      } else {
        ws.terminate();
      }
    } catch {
      // ignore
    }
    throw e;
  }
};
