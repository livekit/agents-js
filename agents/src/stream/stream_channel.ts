// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ReadableStream } from 'node:stream/web';
import { IdentityTransform } from './identity_transform.js';

export interface StreamChannel<T, E extends Error = Error> {
  write(chunk: T): Promise<void>;
  close(): Promise<void>;
  stream(): ReadableStream<T>;
  abort(error: E): Promise<void>;
  readonly closed: boolean;
  addStreamInput(stream: ReadableStream<T>): void;
}

export function createStreamChannel<T, E extends Error = Error>(): StreamChannel<T, E> {
  const transform = new IdentityTransform<T>();
  const writer = transform.writable.getWriter();
  let isClosed = false;

  return {
    write: (chunk: T) => writer.write(chunk),
    stream: () => transform.readable,
    abort: (error: E) => {
      isClosed = true;
      return writer.abort(error);
    },
    addStreamInput: (newInputStream) => {
      const reader = newInputStream.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      })();
    },
    close: async () => {
      try {
        const result = await writer.close();
        isClosed = true;
        return result;
      } catch (e) {
        if (e instanceof Error && e.name === 'TypeError') {
          // Ignore error if the stream is already closed
          isClosed = true;
          return;
        }
        throw e;
      }
    },
    get closed() {
      return isClosed;
    },
  };
}
