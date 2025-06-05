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

  it('should throw error when trying to detach source before setting it', async () => {
    const deferred = new DeferredReadableStream<string>();

    // Attempting to detach source before setting it should throw
    await expect(deferred.detachSource()).rejects.toThrow('Source not set');
  });

  it('read returns undefined as soon as reader is cancelled', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();
    const readPromise = reader.read();

    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('data');
        controller.close();
      }
    });

    deferred.setSource(source);

    // Cancel the stream after setting source
    await reader.cancel();

    const result = await readPromise;
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();

    reader.releaseLock();
  });


  it('reads after detaching source should return undefined', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();
    const readPromise = reader.read();

    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('first');
        controller.enqueue('second');
        controller.close();
      }
    });

    deferred.setSource(source);

    // Detach the source
    await deferred.detachSource();

    const result = await readPromise;
    expect(result.done).toBe(false);
    expect(result.value).toBe('first');

    const result2 = await reader.read();
    expect(result2.done).toBe(true);
    expect(result2.value).toBeUndefined();
    reader.releaseLock();

    const reader2 = source.getReader();
    const result3 = await reader2.read();
    expect(result3.done).toBe(false);
    expect(result3.value).toBe('second');

    const result4 = await reader2.read();
    expect(result4.done).toBe(true);
    expect(result4.value).toBeUndefined();
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

  it('source can be set by another deferred stream after calling detach', async () => {
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

    const result2Promise = reader.read();

    // detach the source
    await deferred.detachSource();

    // read second chunk
    const result2 = await result2Promise;
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

  it("an always-awaiting source reader releases lock after detaching", async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();
    const readPromise = reader.read();
    let resumeSource = false;

    const source = new ReadableStream<string>({
        async start(controller) {
            while (!resumeSource) await delay(10);

            controller.enqueue('data');
            controller.close();
        }
    });

    deferred.setSource(source);
    // the trick here is that we have to do both reader.cancel() and detachSource() in this exact order
    await reader.cancel();
    await deferred.detachSource();
    await delay(100);

    // read before detach should return undefined since source never resumed
    const result = await readPromise;
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();

    const reader2 = source.getReader();
    resumeSource = true;

    // read after detach should return correct order of data since source resumed
    const result2 = await reader2.read();
    expect(result2.done).toBe(false);
    expect(result2.value).toBe('data');

    const result3 = await reader2.read();
    expect(result3.done).toBe(true);
    expect(result3.value).toBeUndefined();

    reader2.releaseLock();
  })
});
