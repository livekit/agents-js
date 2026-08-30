// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, Future } from '@livekit/agents';
import type { IncomingMessage } from 'node:http';
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
  const fut = new Future<void>();

  let timeout: NodeJS.Timeout | undefined;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    ws.off('open', onOpen);
    ws.off('unexpected-response', onUnexpectedResponse);
    ws.off('error', onError);
    ws.off('close', onClose);
  };

  const onOpen = () => fut.resolve();
  const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
    response.resume();
    const statusCode = response.statusCode ?? -1;
    fut.reject(
      new APIStatusError({
        message: `xAI WebSocket connection rejected with status ${statusCode}`,
        options: { statusCode },
      }),
    );
  };
  const onError = (error: Error) =>
    fut.reject(
      new APIConnectionError({ message: `failed to connect to xAI (${errorName(error)})` }),
    );
  const onClose = () =>
    fut.reject(new APIConnectionError({ message: 'failed to connect to xAI (CloseEvent)' }));

  ws.on('open', onOpen);
  ws.on('unexpected-response', onUnexpectedResponse);
  ws.on('error', onError);
  ws.on('close', onClose);

  if (timeoutMs > 0) {
    timeout = setTimeout(() => fut.reject(new Error('connect timeout')), timeoutMs);
  }

  try {
    await fut.await;
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
  } finally {
    cleanup();
  }
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
