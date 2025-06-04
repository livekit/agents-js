// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { delay } from '@std/async/delay';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { DeferredReadableStream } from '../../src/stream/deferred_stream.js';

describe('DeferredReadableStream', () => {
  it('should create a readable stream', () => {
    const deferred = new DeferredReadableStream<string>();
    expect(deferred.stream).toBeInstanceOf(ReadableStream);
  });

  it('should keep reader awaiting before source is set, then read after source is set', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    // Track if read operation is still pending
    let readCompleted = false;
    let readResult: any = null;

    // Start reading - this should hang until source is set
    const readPromise = reader.read().then((result) => {
      readCompleted = true;
      readResult = result;
      return result;
    });

    // Give some time to ensure read doesn't complete immediately
    await delay(50);
    expect(readCompleted).toBe(false);

    // Create and set the source
    const sourceData = ['hello', 'world'];
    const source = new ReadableStream<string>({
      start(controller) {
        sourceData.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    });

    deferred.setSource(source);

    // Now the read should complete
    const result = await readPromise;
    expect(readCompleted).toBe(true);
    expect(result.done).toBe(false);
    expect(result.value).toBe('hello');

    // Read the second chunk
    const result2 = await reader.read();
    expect(result2.done).toBe(false);
    expect(result2.value).toBe('world');

    // Stream should be closed
    const result3 = await reader.read();
    expect(result3.done).toBe(true);
    expect(result3.value).toBeUndefined();

    reader.releaseLock();
  });

  it('should handle multiple chunks from source', async () => {
    const deferred = new DeferredReadableStream<number>();
    const chunks: number[] = [];

    // Set up a reader that collects all chunks
    const collectPromise = (async () => {
      const reader = deferred.stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    })();

    // Create a source that emits multiple chunks over time
    const source = new ReadableStream<number>({
      async start(controller) {
        for (let i = 0; i < 5; i++) {
          controller.enqueue(i);
          await delay(10);
        }
        controller.close();
      },
    });

    // Set the source
    deferred.setSource(source);

    // Wait for all chunks to be collected
    await collectPromise;

    expect(chunks).toEqual([0, 1, 2, 3, 4]);
  });

  it('should propagate errors from source to reader', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    // Start reading
    const readPromise = reader.read();

    // Create a source that errors
    const errorMessage = 'Source error';
    const source = new ReadableStream<string>({
      start(controller) {
        controller.error(new Error(errorMessage));
      },
    });

    try {
        await deferred.setSource(source);
        expect.fail('setSource should have thrown');
    } catch (e: any) {
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toBe('Source error');
    }

    // The read should reject with the error
    try {
        await readPromise;
        expect.fail('readPromise should have rejected');
    } catch (e: any) {
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toBe('Source error');
    }

    reader.releaseLock();
  });

  it('should throw error when trying to set source twice', () => {
    const deferred = new DeferredReadableStream<string>();

    const source1 = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('first');
        controller.close();
      },
    });

    const source2 = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('second');
        controller.close();
      },
    });

    // First setSource should work
    deferred.setSource(source1);

    // Second setSource should throw
    expect(() => deferred.setSource(source2)).toThrow('Stream source already set');
  });

  it('should handle cancellation before source is set', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    // Cancel the stream before setting source
    await reader.cancel('User cancelled')
    reader.releaseLock();

    // Create a source
    let sourceCancelled = false;
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('data');
      },
      cancel(reason) {
        sourceCancelled = true;
      },
    });

    // Setting source after cancellation should still work but the source should be cancelled
    try {
        await deferred.setSource(source);
        expect.fail('setSource should have thrown');
    } catch (e: any) {
        expect(e).toBe('User cancelled');
    }

    // Give time for cancellation to propagate
    await delay(50);

    // The source should have been cancelled
    expect(sourceCancelled).toBe(true);
  });

  it('should handle empty source stream', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    // Start reading
    const readPromise = reader.read();

    // Set an empty source
    const source = new ReadableStream<string>({
      start(controller) {
        controller.close();
      },
    });

    deferred.setSource(source);

    // Read should indicate end of stream
    const result = await readPromise;
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();

    reader.releaseLock();
  });
});
