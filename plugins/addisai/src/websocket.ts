// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError } from '@livekit/agents';
import WebSocket, { type RawData } from 'ws';
import { isRecord } from './utils.js';

export function validateTicketURL(value: unknown, expectedPath: string): URL {
  if (typeof value !== 'string' || !value) throw connectionError('invalid WebSocket URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw connectionError('invalid WebSocket URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== expectedPath ||
    (url.protocol !== 'wss:' && !(local && url.protocol === 'ws:'))
  ) {
    throw connectionError('invalid WebSocket URL');
  }
  return url;
}

export async function connectWebSocket(url: URL, timeoutMs: number): Promise<WebSocket> {
  const socket = new WebSocket(url, { handshakeTimeout: timeoutMs });
  await new Promise<void>((resolve, reject) => {
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(connectionError(`WebSocket connection failed: ${error.message}`));
    };
    const cleanup = () => {
      socket.off('open', opened);
      socket.off('error', failed);
    };
    socket.once('open', opened);
    socket.once('error', failed);
  });
  return socket;
}

export class JsonMessageQueue {
  #values: Array<Record<string, unknown>> = [];
  #waiters: Array<{
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }> = [];
  #failure?: Error;

  constructor(private socket: WebSocket) {
    socket.on('message', this.onMessage);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  async next(): Promise<Record<string, unknown>> {
    const value = this.#values.shift();
    if (value) return value;
    if (this.#failure) throw this.#failure;
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  close(): void {
    this.socket.off('message', this.onMessage);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.fail(connectionError('WebSocket queue closed'));
  }

  private onMessage = (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isRecord(parsed)) throw new Error('event is not an object');
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(parsed);
      else this.#values.push(parsed);
    } catch {
      this.fail(connectionError('AddisAI returned invalid WebSocket JSON'));
    }
  };

  private onError = (error: Error) => this.fail(connectionError(error.message));

  private onClose = () => this.fail(connectionError('AddisAI WebSocket closed unexpectedly'));

  private fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

function connectionError(message: string): APIConnectionError {
  return new APIConnectionError({
    message: `AddisAI ${message}`,
    options: { retryable: true },
  });
}
