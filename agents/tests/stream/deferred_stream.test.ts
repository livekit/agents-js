// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { delay } from '@std/async/delay';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { DeferredReadableStream } from '../../src/stream/deferred_stream.js';

describe('DeferredReadableStream', { timeout: 2000 }, () => {
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
      async start(controller) {
        controller.error(new Error(errorMessage));
      },
      cancel(reason) {
        console.log('cancel', reason);
      },
    });

    deferred.setSource(source);

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

  it('read after cancellation should return undefined', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();
    const readPromise = reader.read();

    // Cancel the stream before setting source
    await reader.cancel();

    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('data');
      }
    });

    deferred.setSource(source);

    const result = await readPromise;
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();

    reader.releaseLock();
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

  it('source set by another deferred stream after calling cancel()', async () => {
    const deferred = new DeferredReadableStream<string>();
    
    // Create a new source stream
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('before-cancel');
        controller.enqueue('after-cancel');
        controller.close();
      },
    });

    // read first chunk
    deferred.setSource(source);
    const reader = deferred.stream.getReader();
    const result = await reader.read();
    expect(result.done).toBe(false);
    expect(result.value).toBe('before-cancel');

    // cancel the stream
    await deferred.cancel();

    // read second chunk
    const result2 = await reader.read();
    expect(result2.done).toBe(true);
    expect(result2.value).toBeUndefined();

    // we manually release the lock
    reader.releaseLock();

    // create a new deferred stream and set the source
    const deferred2 = new DeferredReadableStream<string>();
    deferred2.setSource(source);
    const reader2 = deferred2.stream.getReader();

    // read the second chunk
    const result3 = await reader2.read();
    expect(result3.done).toBe(false);
    expect(result3.value).toBe('after-cancel');

    // read the third chunk
    const result4 = await reader2.read();
    expect(result4.done).toBe(true);
    expect(result4.value).toBeUndefined();
    reader2.releaseLock();
  });
});
