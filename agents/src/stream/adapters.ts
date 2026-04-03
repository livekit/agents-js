// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { Chan, ChanClosed } from './chan.js';

/**
 * Convert a ReadableStream into an AsyncIterable backed by a Chan.
 *
 * This is an adapter for interop with external APIs (e.g., AudioStream from rtc-node)
 * that still expose ReadableStream. The returned AsyncIterable can be used with
 * `for await...of` and integrates cleanly with the Chan-based architecture.
 *
 * @param stream - The ReadableStream to convert
 * @param signal - Optional AbortSignal to stop reading early
 * @returns An AsyncIterable that yields all values from the stream
 */
export function fromReadableStream<T>(
  stream: ReadableStream<T>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  const ch = new Chan<T>();

  // Pump the ReadableStream into the channel in the background
  (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        try {
          ch.sendNowait(value);
        } catch (e) {
          if (e instanceof ChanClosed) break;
          throw e;
        }
      }
    } catch {
      // Stream errors are silently consumed; the channel will close
    } finally {
      reader.releaseLock();
      ch.close();
    }
  })();

  return signal ? ch.iter(signal) : ch;
}

/**
 * Convert an AsyncIterable into a ReadableStream.
 *
 * This is an adapter for interop with APIs that require ReadableStream
 * (e.g., external libraries, WebRTC tracks). It consumes the async iterable
 * and enqueues each value into the ReadableStream.
 *
 * @param iterable - The AsyncIterable to convert
 * @param signal - Optional AbortSignal to stop iteration early
 * @returns A ReadableStream that yields all values from the iterable
 */
export function toReadableStream<T>(
  iterable: AsyncIterable<T>,
  signal?: AbortSignal,
): ReadableStream<T> {
  return new ReadableStream<T>({
    async start(controller) {
      try {
        for await (const value of iterable) {
          if (signal?.aborted) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/**
 * Merge multiple AsyncIterables into a single AsyncIterable.
 *
 * All sources are consumed concurrently. Values are yielded in the order
 * they arrive (interleaved). The output closes when all sources are exhausted.
 *
 * @param sources - The AsyncIterables to merge
 * @returns A single AsyncIterable yielding values from all sources
 */
export function mergeAsyncIterables<T>(...sources: AsyncIterable<T>[]): AsyncIterable<T> {
  const ch = new Chan<T>();

  let remaining = sources.length;
  if (remaining === 0) {
    ch.close();
    return ch;
  }

  for (const source of sources) {
    (async () => {
      try {
        for await (const value of source) {
          try {
            ch.sendNowait(value);
          } catch (e) {
            if (e instanceof ChanClosed) return;
            throw e;
          }
        }
      } catch {
        // Source errors are silently consumed
      } finally {
        remaining--;
        if (remaining === 0) {
          ch.close();
        }
      }
    })();
  }

  return ch;
}
