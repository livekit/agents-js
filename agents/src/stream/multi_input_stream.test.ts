// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { delay } from '../utils.js';
import { MultiInputStream } from './multi_input_stream.js';

function streamFrom<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const v of values) controller.enqueue(v);
      controller.close();
    },
  });
}

describe('MultiInputStream', () => {
  // ---------------------------------------------------------------------------
  // Basic functionality
  // ---------------------------------------------------------------------------

  it('should create a readable output stream', () => {
    const multi = new MultiInputStream<string>();
    expect(multi.stream).toBeInstanceOf(ReadableStream);
    expect(multi.inputCount).toBe(0);
    expect(multi.isClosed).toBe(false);
  });

  it('should read data from a single input stream', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    multi.addInputStream(streamFrom(['a', 'b', 'c']));

    const results: string[] = [];
    // Read three values then close manually (output stays open after input ends).
    for (let i = 0; i < 3; i++) {
      const { value } = await reader.read();
      results.push(value!);
    }

    expect(results).toEqual(['a', 'b', 'c']);
    reader.releaseLock();
    await multi.close();
  });

  it('should merge data from multiple input streams', async () => {
    const multi = new MultiInputStream<number>();
    const reader = multi.stream.getReader();

    multi.addInputStream(streamFrom([1, 2]));
    multi.addInputStream(streamFrom([3, 4]));

    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { value } = await reader.read();
      results.push(value!);
    }

    // Order is non-deterministic but all values must arrive.
    expect(results.sort()).toEqual([1, 2, 3, 4]);
    reader.releaseLock();
    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Dynamic add / remove
  // ---------------------------------------------------------------------------

  it('should allow adding inputs dynamically while reading', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    multi.addInputStream(streamFrom(['first']));

    const r1 = await reader.read();
    expect(r1.value).toBe('first');

    // Add a second input after reading from the first.
    multi.addInputStream(streamFrom(['second']));

    const r2 = await reader.read();
    expect(r2.value).toBe('second');

    reader.releaseLock();
    await multi.close();
  });

  it('should continue reading from remaining inputs after removing one', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    // A slow stream that emits over time.
    const slowSource = new ReadableStream<string>({
      async start(controller) {
        controller.enqueue('slow-1');
        await delay(50);
        controller.enqueue('slow-2');
        await delay(50);
        controller.enqueue('slow-3');
        controller.close();
      },
    });

    const slowId = multi.addInputStream(slowSource);

    // Read first value from slow source.
    const r1 = await reader.read();
    expect(r1.value).toBe('slow-1');

    // Remove the slow source and add a fast one.
    await multi.removeInputStream(slowId);

    multi.addInputStream(streamFrom(['fast-1', 'fast-2']));

    const r2 = await reader.read();
    expect(r2.value).toBe('fast-1');

    const r3 = await reader.read();
    expect(r3.value).toBe('fast-2');

    reader.releaseLock();
    await multi.close();
  });

  it('should handle swapping inputs (remove then add)', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    const id1 = multi.addInputStream(streamFrom(['from-A']));

    const r1 = await reader.read();
    expect(r1.value).toBe('from-A');

    await multi.removeInputStream(id1);

    const id2 = multi.addInputStream(streamFrom(['from-B']));

    const r2 = await reader.read();
    expect(r2.value).toBe('from-B');

    await multi.removeInputStream(id2);
    reader.releaseLock();
    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Reading before any input is added
  // ---------------------------------------------------------------------------

  it('should keep reader awaiting until an input is added', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    let readCompleted = false;
    const readPromise = reader.read().then((result) => {
      readCompleted = true;
      return result;
    });

    await delay(50);
    expect(readCompleted).toBe(false);

    // Now add an input to unblock the read.
    multi.addInputStream(streamFrom(['hello']));

    const result = await readPromise;
    expect(readCompleted).toBe(true);
    expect(result.value).toBe('hello');

    reader.releaseLock();
    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Empty input streams
  // ---------------------------------------------------------------------------

  it('should handle empty input streams without closing the output', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    // Add an empty stream — it should end immediately without affecting the output.
    multi.addInputStream(streamFrom([]));

    await delay(20);

    // The output should still be open. Adding a real input should work.
    multi.addInputStream(streamFrom(['data']));

    const result = await reader.read();
    expect(result.value).toBe('data');

    reader.releaseLock();
    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('should remove errored input without killing the output', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    // An input that errors after emitting one value.
    const errorSource = new ReadableStream<string>({
      async start(controller) {
        controller.enqueue('before-error');
        await delay(20);
        controller.error(new Error('boom'));
      },
    });

    multi.addInputStream(errorSource);

    const r1 = await reader.read();
    expect(r1.value).toBe('before-error');

    // Wait for the error to propagate and the input to be removed.
    await delay(50);

    expect(multi.inputCount).toBe(0);

    // The output is still alive — we can add another input.
    multi.addInputStream(streamFrom(['after-error']));

    const r2 = await reader.read();
    expect(r2.value).toBe('after-error');

    reader.releaseLock();
    await multi.close();
  });

  it('should keep other inputs alive when one errors', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    const goodSource = new ReadableStream<string>({
      async start(controller) {
        await delay(60);
        controller.enqueue('good');
        controller.close();
      },
    });

    const badSource = new ReadableStream<string>({
      async start(controller) {
        controller.error(new Error('bad'));
      },
    });

    multi.addInputStream(goodSource);
    multi.addInputStream(badSource);

    // Wait a bit for the bad source to error and be removed.
    await delay(10);

    // The good source should still be pumping.
    const result = await reader.read();
    expect(result.value).toBe('good');

    reader.releaseLock();
    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Close semantics
  // ---------------------------------------------------------------------------

  it('should end the output stream with done:true when close is called', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    multi.addInputStream(streamFrom(['data']));

    const r1 = await reader.read();
    expect(r1.value).toBe('data');

    await multi.close();

    const r2 = await reader.read();
    expect(r2.done).toBe(true);
    expect(r2.value).toBeUndefined();

    reader.releaseLock();
  });

  it('should resolve pending reads as done when close is called', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    // No inputs — read will be pending.
    const readPromise = reader.read();

    await delay(10);
    await multi.close();

    const result = await readPromise;
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();

    reader.releaseLock();
  });

  it('should be idempotent for multiple close calls', async () => {
    const multi = new MultiInputStream<string>();

    await multi.close();
    await multi.close();

    expect(multi.isClosed).toBe(true);
  });

  it('should throw when adding input after close', async () => {
    const multi = new MultiInputStream<string>();
    await multi.close();

    expect(() => multi.addInputStream(streamFrom(['x']))).toThrow('MultiInputStream is closed');
  });

  // ---------------------------------------------------------------------------
  // removeInputStream edge cases
  // ---------------------------------------------------------------------------

  it('should no-op when removing a non-existent input', async () => {
    const multi = new MultiInputStream<string>();

    // Should not throw.
    await multi.removeInputStream('does-not-exist');

    await multi.close();
  });

  it('should release the source reader lock so the source can be reused', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    const source = new ReadableStream<string>({
      async start(controller) {
        controller.enqueue('chunk-0');
        await delay(30);
        controller.enqueue('chunk-1');
        controller.close();
      },
    });

    const id = multi.addInputStream(source);

    const r1 = await reader.read();
    expect(r1.value).toBe('chunk-0');

    await multi.removeInputStream(id);

    // The source's reader lock should be released — we can get a new reader.
    const sourceReader = source.getReader();
    const sr = await sourceReader.read();
    expect(sr.value).toBe('chunk-1');
    sourceReader.releaseLock();

    reader.releaseLock();
    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Input count tracking
  // ---------------------------------------------------------------------------

  it('should track inputCount correctly through add / remove / natural end', async () => {
    const multi = new MultiInputStream<string>();

    expect(multi.inputCount).toBe(0);

    const id1 = multi.addInputStream(streamFrom(['a']));
    const id2 = multi.addInputStream(streamFrom(['b']));

    expect(multi.inputCount).toBe(2);

    await multi.removeInputStream(id1);
    expect(multi.inputCount).toBeLessThanOrEqual(1);

    // Let the remaining stream finish.
    await delay(20);
    expect(multi.inputCount).toBe(0);

    await multi.removeInputStream(id2); // already gone, no-op
    expect(multi.inputCount).toBe(0);

    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Concurrent reads and writes
  // ---------------------------------------------------------------------------

  it('should handle concurrent reads and slow writes', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    const chunks = ['a', 'b', 'c', 'd', 'e'];
    let idx = 0;

    const source = new ReadableStream<string>({
      start(controller) {
        const writeNext = () => {
          if (idx < chunks.length) {
            controller.enqueue(chunks[idx++]);
            setTimeout(writeNext, 5);
          } else {
            controller.close();
          }
        };
        writeNext();
      },
    });

    multi.addInputStream(source);

    const results: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const { value } = await reader.read();
      results.push(value!);
    }

    expect(results).toEqual(chunks);

    reader.releaseLock();
    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Backpressure
  // ---------------------------------------------------------------------------

  it('should handle backpressure with large data', async () => {
    const multi = new MultiInputStream<string>();

    const largeChunks = Array.from({ length: 1000 }, (_, i) => `chunk-${i}`);
    multi.addInputStream(streamFrom(largeChunks));

    const reader = multi.stream.getReader();
    const results: string[] = [];

    let result = await reader.read();
    while (!result.done) {
      results.push(result.value);
      // Check if we've collected all expected values before reading again,
      // to avoid hanging on the output which stays open after input ends.
      if (results.length === largeChunks.length) break;
      result = await reader.read();
    }

    expect(results).toEqual(largeChunks);

    reader.releaseLock();
    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Multiple tee / concurrent consumers
  // ---------------------------------------------------------------------------

  it('should support tee on the output stream', async () => {
    const multi = new MultiInputStream<number>();

    const [s1, s2] = multi.stream.tee();
    const r1 = s1.getReader();
    const r2 = s2.getReader();

    multi.addInputStream(streamFrom([10, 20]));

    const [a1, a2] = await Promise.all([r1.read(), r2.read()]);
    expect(a1.value).toBe(10);
    expect(a2.value).toBe(10);

    const [b1, b2] = await Promise.all([r1.read(), r2.read()]);
    expect(b1.value).toBe(20);
    expect(b2.value).toBe(20);

    r1.releaseLock();
    r2.releaseLock();
    await multi.close();
  });

  // ---------------------------------------------------------------------------
  // Return value of addInputStream
  // ---------------------------------------------------------------------------

  it('should return unique IDs from addInputStream', () => {
    const multi = new MultiInputStream<string>();

    const id1 = multi.addInputStream(streamFrom(['a']));
    const id2 = multi.addInputStream(streamFrom(['b']));
    const id3 = multi.addInputStream(streamFrom(['c']));

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  // ---------------------------------------------------------------------------
  // close() while pumps are actively writing
  // ---------------------------------------------------------------------------

  it('should cleanly close while pumps are actively writing', async () => {
    const multi = new MultiInputStream<string>();
    const reader = multi.stream.getReader();

    // A source that never stops on its own.
    const infiniteSource = new ReadableStream<string>({
      async start(controller) {
        let i = 0;
        while (true) {
          try {
            controller.enqueue(`tick-${i++}`);
          } catch {
            // controller.enqueue throws after stream is canceled
            break;
          }
          await delay(5);
        }
      },
    });

    multi.addInputStream(infiniteSource);

    // Read a couple of values.
    const r1 = await reader.read();
    expect(r1.done).toBe(false);

    // Close while the infinite source is still pumping.
    await multi.close();

    const r2 = await reader.read();
    expect(r2.done).toBe(true);

    reader.releaseLock();
  });
});
