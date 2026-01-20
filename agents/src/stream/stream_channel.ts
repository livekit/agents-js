// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ReadableStream } from 'node:stream/web';
import { IdentityTransform } from './identity_transform.js';

export interface StreamChannel<T> {
  write(chunk: T): Promise<void>;
  close(): Promise<void>;
  stream(): ReadableStream<T>;
  readonly closed: boolean;
}

export function createStreamChannel<T>(): StreamChannel<T> {
  const transform = new IdentityTransform<T>();
  const writer = transform.writable.getWriter();
  let isClosed = false;

  return {
    write: (chunk: T) => writer.write(chunk),
    stream: () => transform.readable,
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
