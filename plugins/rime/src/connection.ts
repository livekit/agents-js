// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { create, fromBinary, fromJsonString, toBinary, toJsonString } from '@bufbuild/protobuf';
import {
  APIConnectionError,
  APIError,
  APIStatusError,
  APITimeoutError,
  AsyncIterableQueue,
  ConnectionPool,
} from '@livekit/agents';
import {
  type WebSocketError,
  type WebSocketRequest,
  WebSocketRequestSchema,
  type WebSocketResponse,
  WebSocketResponseSchema,
} from '@rimelabs/api';
import { type RawData, WebSocket } from 'ws';
import type { WebSocketProtocol } from './options.js';
import type { TTS } from './tts.js';

// Match the other JS TTS plugins: keep connection pools out of the public constructor.
export const connectionPools = new WeakMap<TTS, RimePool>();

export const connectionError = () =>
  new APIConnectionError({ message: 'Rime WebSocket transport failed' });

export async function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeout?: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('Rime operation cancelled'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        if (timeout !== undefined)
          timer = setTimeout(
            () => reject(new APITimeoutError({ message: 'Rime operation timed out' })),
            timeout,
          );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export function providerError(error: WebSocketError, requestId?: string): APIError {
  if (!error.kind) return new APIError('Rime v1 sent a malformed error', { retryable: false });
  const statuses: Record<string, number> = {
    invalid_input: 400,
    unauthenticated: 401,
    permission_denied: 403,
    not_found: 404,
    resource_exhausted: 429,
    timeout: 504,
    unavailable: 503,
    unimplemented: 501,
    internal: 500,
  };
  const known = Object.hasOwn(statuses, error.kind);
  return new APIStatusError({
    message: 'Rime v1 request failed',
    options: {
      statusCode: known ? statuses[error.kind] : 500,
      requestId: error.requestId ?? requestId,
      body: { kind: known ? error.kind : 'unknown' },
      retryable: error.kind !== 'unimplemented',
    },
  });
}

export function decodeResponse(
  data: Uint8Array,
  binary: boolean,
  protocol: WebSocketProtocol,
): WebSocketResponse {
  try {
    if (binary !== (protocol === 'binary')) throw connectionError();
    let response: WebSocketResponse;
    if (protocol === 'binary') response = fromBinary(WebSocketResponseSchema, data);
    else {
      const text = Buffer.from(data).toString('utf8');
      const json = JSON.parse(text);
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw connectionError();
      const payloads = ['ready', 'started', 'audio', 'done', 'cancelled', 'error'].filter(
        (key) => key in json,
      );
      if (payloads.length !== 1) throw connectionError();
      const name = payloads[0]!;
      const value = json[name];
      if (name === 'audio') {
        if (
          typeof value !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
        )
          throw connectionError();
      } else if (!value || typeof value !== 'object' || Array.isArray(value))
        throw connectionError();
      response = fromJsonString(WebSocketResponseSchema, text, { ignoreUnknownFields: true });
    }
    if (!response.payload.case) throw connectionError();
    return response;
  } catch {
    throw new APIConnectionError({ message: 'Rime v1 sent an invalid protocol envelope' });
  }
}

export class RimeConnection {
  private inbox = new AsyncIterableQueue<{ data: Buffer; binary: boolean } | APIError>();
  private failed = false;
  private pending = 0;
  private constructor(
    readonly socket: WebSocket,
    readonly protocol?: WebSocketProtocol,
  ) {
    socket.on('message', (raw: RawData, binary: boolean) => {
      if (this.inbox.closed) return;
      const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      this.pending++;
      this.inbox.put({ data, binary });
    });
    socket.on('error', () => this.fail(connectionError()));
    socket.on('close', () => this.fail(connectionError()));
  }

  private fail(error: APIError) {
    if (this.failed || this.inbox.closed) return;
    this.failed = true;
    this.inbox.put(error);
  }

  get reusable() {
    return !this.failed && this.pending === 0 && this.socket.readyState === WebSocket.OPEN;
  }

  static async connect(
    url: string,
    apiKey: string,
    timeout: number,
    protocol?: WebSocketProtocol,
    abortSignal?: AbortSignal,
  ): Promise<RimeConnection> {
    let connection: RimeConnection | undefined;
    const controller = new AbortController();
    const signal = abortSignal
      ? AbortSignal.any([controller.signal, abortSignal])
      : controller.signal;
    try {
      if (signal.aborted) throw connectionError();
      const ws = new WebSocket(url, protocol ? [`rime.v1.${protocol}`] : [], {
        headers: { Authorization: `Bearer ${apiKey}` },
        handshakeTimeout: timeout,
        followRedirects: false,
      });
      connection = new RimeConnection(ws, protocol);
      await bounded(
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            ws.off('open', onOpen);
            ws.off('error', onError);
            ws.off('close', onError);
            ws.off('unexpected-response', onResponse);
          };
          const onOpen = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(connectionError());
          };
          const onResponse = (_req: unknown, res: { statusCode?: number; destroy(): void }) => {
            cleanup();
            res.destroy();
            reject(
              new APIStatusError({
                message: 'Rime WebSocket handshake failed',
                options: { statusCode: res.statusCode },
              }),
            );
          };
          ws.once('open', onOpen);
          ws.once('error', onError);
          ws.once('close', onError);
          ws.once('unexpected-response', onResponse);
        }),
        signal,
        timeout,
      );
      if (protocol) {
        if (ws.protocol !== `rime.v1.${protocol}`)
          throw new APIConnectionError({
            message: 'Rime selected an unsupported WebSocket subprotocol',
            options: { retryable: false },
          });
        const response = await connection.receiveV1(signal, timeout);
        if (response.payload.case === 'error') throw providerError(response.payload.value);
        if (
          response.contextId ||
          response.payload.case !== 'ready' ||
          response.payload.value.protocol !== 1
        )
          throw new APIConnectionError({ message: 'Rime v1 did not send a valid ready event' });
      }
      return connection;
    } catch (error) {
      await connection?.close();
      if (error instanceof APIError) throw error;
      throw connectionError();
    } finally {
      controller.abort();
    }
  }

  async receive(signal: AbortSignal, timeout?: number) {
    const timer = new AbortController();
    let handle: NodeJS.Timeout | undefined;
    if (timeout !== undefined) handle = setTimeout(() => timer.abort(), timeout);
    try {
      const result = await this.inbox.next({ signal: AbortSignal.any([signal, timer.signal]) });
      if (result.done) throw connectionError();
      if (result.value instanceof APIError) throw result.value;
      this.pending--;
      return result.value;
    } catch (error) {
      if (timer.signal.aborted && !signal.aborted)
        throw new APITimeoutError({ message: 'Timed out waiting for a Rime event' });
      throw error;
    } finally {
      if (handle) clearTimeout(handle);
    }
  }

  async receiveV1(signal: AbortSignal, timeout?: number) {
    const frame = await this.receive(signal, timeout);
    return decodeResponse(frame.data, frame.binary, this.protocol!);
  }

  async send(data: string | Uint8Array, signal: AbortSignal, timeout: number) {
    if (signal.aborted) throw new Error('Rime operation cancelled');
    try {
      if (this.socket.readyState !== WebSocket.OPEN) throw connectionError();
      await bounded(
        new Promise<void>((resolve, reject) =>
          this.socket.send(data, (error) => (error ? reject(connectionError()) : resolve())),
        ),
        signal,
        timeout,
      );
    } catch (error) {
      if (error instanceof APIError) throw error;
      throw connectionError();
    }
  }

  sendV1(
    contextId: string,
    payload: WebSocketRequest['payload'],
    signal: AbortSignal,
    timeout: number,
  ) {
    const request = create(WebSocketRequestSchema, { contextId, payload });
    return this.send(
      this.protocol === 'binary'
        ? toBinary(WebSocketRequestSchema, request)
        : toJsonString(WebSocketRequestSchema, request),
      signal,
      timeout,
    );
  }

  async close() {
    this.failed = true;
    if (!this.inbox.closed) this.inbox.close();
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.terminate();
    });
  }
}

/** Streams retain their original endpoint pool until their retry loop ends. */
export class RimePool {
  readonly pool: ConnectionPool<RimeConnection>;
  private users = 0;
  private retired = false;
  private closing?: Promise<void>;
  private closeController = new AbortController();
  private connecting = new Set<Promise<RimeConnection>>();
  constructor(
    url: string,
    key: string,
    protocol?: WebSocketProtocol,
    private onClosed?: () => void,
  ) {
    this.pool = new ConnectionPool({
      maxSessionDuration: 300_000,
      markRefreshedOnGet: true,
      connectCb: (timeout) => {
        const signal = this.closeController.signal;
        if (signal.aborted) return Promise.reject(connectionError());
        const pending = (async () => {
          const connection = await RimeConnection.connect(url, key, timeout, protocol, signal);
          if (signal.aborted) {
            await connection.close();
            throw connectionError();
          }
          return connection;
        })();
        this.connecting.add(pending);
        void pending.then(
          () => this.connecting.delete(pending),
          () => this.connecting.delete(pending),
        );
        return pending;
      },
      closeCb: async (connection) => {
        await connection.close();
      },
    });
  }
  retain() {
    this.users++;
  }
  release() {
    this.users--;
    if (!this.users && this.retired) void this.close();
  }
  retire() {
    this.retired = true;
    if (!this.users) void this.close();
  }
  async close() {
    this.retired = true;
    this.closeController.abort();
    this.closing ??= (async () => {
      await Promise.allSettled([...this.connecting]);
      await this.pool.close();
    })().finally(() => this.onClosed?.());
    await this.closing;
  }
}
