// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ReadableStream } from 'node:stream/web';
import { tryLog } from '../log.js';
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

  // The consumer side can cancel the readable (or the stream can error), which
  // errors the writable and would otherwise reject every later write() and
  // close() with the cancel reason - surfacing as unhandled rejections from
  // fire-and-forget producers.
  writer.closed.catch((error: unknown) => {
    if (!isClosed) {
      isClosed = true;
      tryLog()?.debug({ error }, 'stream channel writable errored or was cancelled downstream');
    }
  });

  return {
    write: (chunk: T) => {
      const result = writer.write(chunk);
      // Mark the rejection as handled for fire-and-forget producers; callers
      // that await the returned promise still observe it.
      result.catch((error: unknown) => {
        if (!isClosed) {
          tryLog()?.debug({ error }, 'stream channel write failed');
        }
      });
      return result;
    },
    stream: () => transform.readable,
    abort: async (error: E) => {
      if (isClosed) return;
      isClosed = true;
      try {
        await writer.abort(error);
      } catch (e) {
        if (e instanceof Error && e.name === 'TypeError') return;
        throw e;
      }
    },
    addStreamInput: (newInputStream) => {
      if (isClosed) return;
      const reader = newInputStream.getReader();
      (async () => {
        try {
          while (!isClosed) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        } catch (err) {
          if (!isClosed) {
            isClosed = true;
            await writer.abort(err as E);
          }
        } finally {
          reader.releaseLock();
        }
      })().catch(() => {});
    },
    close: async () => {
      try {
        return await writer.close();
      } catch (e) {
        // Ignore error if the stream is already closed or errored - either way
        // no more data flows, which is what close() asks for.
        if (!isClosed && !(e instanceof Error && e.name === 'TypeError')) {
          tryLog()?.debug({ error: e }, 'stream channel close failed');
        }
      } finally {
        isClosed = true;
      }
    },
    get closed() {
      return isClosed;
    },
  };
}
