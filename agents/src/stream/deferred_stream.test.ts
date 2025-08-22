// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { delay } from '../utils.js';
import { DeferredReadableStream } from './deferred_stream.js';

describe('DeferredReadableStream', () => {
  it('should create a readable stream that can be read after setting source', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    // Create a source stream with test data
    const testData = ['chunk1', 'chunk2', 'chunk3'];
    const source = new ReadableStream<string>({
      start(controller) {
        for (const chunk of testData) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    // Set the source
    deferred.setSource(source);

    // Read all data
    const results: string[] = [];
    let result = await reader.read();
    while (!result.done) {
      results.push(result.value);
      result = await reader.read();
    }

    expect(results).toEqual(testData);
  });

  it('should allow reading from stream before source is set', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    // Start reading before source is set (this should not resolve immediately)
    const readPromise = reader.read();

    // Wait a bit to ensure the read is pending
    await delay(10);

    // Now set the source
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue('test-value');
        controller.close();
      },
    });

    deferred.setSource(source);

    // The read should now resolve
    const result = await readPromise;
    expect(result.done).toBe(false);
    expect(result.value).toBe('test-value');

    // Next read should indicate stream completion
    const nextResult = await reader.read();
    expect(nextResult.done).toBe(true);
  });

  it('should throw error when trying to set source on locked stream', async () => {
    const deferred = new DeferredReadableStream<string>();

    // Get a reader to lock the stream
    const reader = deferred.stream.getReader();

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue('test');
        controller.close();
      },
    });

    const source2 = new ReadableStream({
      start(controller) {
        controller.enqueue('test2');
        controller.close();
      },
    });

    expect(() => deferred.setSource(source)).not.toThrow();
    expect(() => deferred.setSource(source2)).toThrow('Stream source already set');

    // Clean up
    reader.releaseLock();
  });

  it('should handle multiple concurrent readers before source is set', async () => {
    const deferred = new DeferredReadableStream<number>();

    // Create multiple readers by using tee()
    const [stream1, stream2] = deferred.stream.tee();
    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();

    // Start reading from both streams concurrently
    const read1Promise = reader1.read();
    const read2Promise = reader2.read();

    // Wait to ensure reads are pending
    await delay(10);

    // Set source with test data
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(42);
        controller.enqueue(84);
        controller.close();
      },
    });

    deferred.setSource(source);

    // Both readers should receive the data
    const [result1, result2] = await Promise.all([read1Promise, read2Promise]);

    expect(result1.done).toBe(false);
    expect(result1.value).toBe(42);
    expect(result2.done).toBe(false);
    expect(result2.value).toBe(42);

    // Read second values
    const [second1, second2] = await Promise.all([reader1.read(), reader2.read()]);
    expect(second1.value).toBe(84);
    expect(second2.value).toBe(84);
  });

  it('should handle concurrent reads and writes', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    // Create a source that writes data over time
    const chunks = ['a', 'b', 'c', 'd', 'e'];
    let chunkIndex = 0;

    const source = new ReadableStream({
      start(controller) {
        const writeNext = () => {
          if (chunkIndex < chunks.length) {
            controller.enqueue(chunks[chunkIndex++]);
            setTimeout(writeNext, 5); // Write next chunk after small delay
          } else {
            controller.close();
          }
        };
        writeNext();
      },
    });

    // Set source and immediately start reading concurrently
    deferred.setSource(source);

    const results: string[] = [];
    const readConcurrently = async () => {
      let result = await reader.read();
      while (!result.done) {
        results.push(result.value);
        result = await reader.read();
      }
    };

    await readConcurrently();
    expect(results).toEqual(chunks);
  });

  it('should handle race condition between setSource and getReader', async () => {
    const deferred = new DeferredReadableStream<string>();

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue('race-test');
        controller.close();
      },
    });

    // Race between setting source and getting reader
    const [, reader] = await Promise.all([
      // Set source
      Promise.resolve().then(() => deferred.setSource(source)),
      // Get reader
      Promise.resolve().then(() => deferred.stream.getReader()),
    ]);

    const result = await reader.read();
    expect(result.value).toBe('race-test');
  });

  it('should handle empty source stream', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    const emptySource = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    deferred.setSource(emptySource);

    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  it('should handle source stream with errors', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    const errorSource = new ReadableStream({
      async start(controller) {
        controller.enqueue('before-error');
        // Use async/await to keep the error within the test scope
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.error(new Error('Source stream error'));
      },
    });

    deferred.setSource(errorSource);

    // Should read the value before error
    const result1 = await reader.read();
    expect(result1.value).toBe('before-error');

    // Next read should throw the error
    await expect(() => reader.read()).rejects.toThrow('Source stream error');
  });

  it('should handle multiple concurrent read operations', async () => {
    const deferred = new DeferredReadableStream<number>();
    const reader = deferred.stream.getReader();

    // Start multiple read operations before setting source
    const readPromises = Array.from({ length: 3 }, () => reader.read());

    await delay(10);

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
    });

    deferred.setSource(source);

    // All reads should resolve with the sequential values
    const results = await Promise.all(readPromises);

    expect(results[0]?.value).toBe(1);
    expect(results[1]?.value).toBe(2);
    expect(results[2]?.value).toBe(3);
    expect(results.every((r) => !r.done)).toBe(true);

    // Final read should indicate completion
    const finalResult = await reader.read();
    expect(finalResult.done).toBe(true);
  });

  it('should handle backpressure correctly', async () => {
    const deferred = new DeferredReadableStream<string>();

    // Create a source with large chunks to test backpressure
    const largeChunks = Array.from({ length: 1000 }, (_, i) => `chunk-${i}`);

    const source = new ReadableStream({
      start(controller) {
        for (const chunk of largeChunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    deferred.setSource(source);

    const reader = deferred.stream.getReader();
    const results: string[] = [];

    // Read all chunks
    let result = await reader.read();
    while (!result.done) {
      results.push(result.value);
      result = await reader.read();
    }

    expect(results).toEqual(largeChunks);
  });

  it('should handle concurrent setSource calls (second should fail)', async () => {
    const deferred = new DeferredReadableStream<string>();

    const source1 = new ReadableStream({
      start(controller) {
        controller.enqueue('first');
        controller.close();
      },
    });

    const source2 = new ReadableStream({
      start(controller) {
        controller.enqueue('second');
        controller.close();
      },
    });

    // First setSource should succeed
    deferred.setSource(source1);

    // Second setSource should fail because stream is now locked
    expect(() => deferred.setSource(source2)).toThrow('Stream source already set');

    // Verify we get data from the first source
    const reader = deferred.stream.getReader();
    const result = await reader.read();
    expect(result.value).toBe('first');
  });

  it('should handle reader release and re-acquire before source is set', async () => {
    const deferred = new DeferredReadableStream<string>();

    // Get reader and immediately release it
    const reader1 = deferred.stream.getReader();
    reader1.releaseLock();

    // Get a new reader
    const reader2 = deferred.stream.getReader();

    // Now set the source
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue('test-after-release');
        controller.close();
      },
    });

    deferred.setSource(source);

    const result = await reader2.read();
    expect(result.value).toBe('test-after-release');
  });

  it('should handle type safety with different data types', async () => {
    interface TestData {
      id: number;
      name: string;
    }

    const deferred = new DeferredReadableStream<TestData>();
    const reader = deferred.stream.getReader();

    const testObject: TestData = { id: 1, name: 'test' };

    const source = new ReadableStream<TestData>({
      start(controller) {
        controller.enqueue(testObject);
        controller.close();
      },
    });

    deferred.setSource(source);

    const result = await reader.read();
    expect(result.value).toEqual(testObject);
    expect(result.value).toBeDefined();
    expect(typeof result.value!.id).toBe('number');
    expect(typeof result.value!.name).toBe('string');
  });

  it('should create a readable stream', () => {
    const deferred = new DeferredReadableStream<string>();
    expect(deferred.stream).toBeInstanceOf(ReadableStream);
  });

  it('should keep reader awaiting before source is set, then read after source is set', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();

    // Track if read operation is still pending
    let readCompleted = false;

    // Start reading - this should hang until source is set
    const readPromise = reader.read().then((result) => {
      readCompleted = true;
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
    } catch (e: unknown) {
      const error = e as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Source error');
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
      },
    });

    deferred.setSource(source);

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
      },
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

  it('a non-terminating source reader releases lock after detaching', async () => {
    const deferred = new DeferredReadableStream<string>();
    const reader = deferred.stream.getReader();
    const readPromise = reader.read();
    let resumeSource = false;

    const source = new ReadableStream<string>({
      async start(controller) {
        while (!resumeSource) await delay(10);

        controller.enqueue('data');
        controller.close();
      },
    });

    deferred.setSource(source);
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
  });

  it('should transfer source between deferred streams while reading is ongoing', async () => {
    const deferred1 = new DeferredReadableStream<string>();
    const deferred2 = new DeferredReadableStream<string>();

    // Create a source that slowly emits data
    const source = new ReadableStream<string>({
      async start(controller) {
        // Emit 5 chunks with delays
        for (let i = 0; i < 4; i++) {
          controller.enqueue(`chunk-${i}`);
          await delay(20); // Small delay between chunks
        }
        controller.close();
      },
    });

    deferred1.setSource(source);
    const reader1 = deferred1.stream.getReader();
    const result1 = await reader1.read();
    expect(result1.done).toBe(false);
    expect(result1.value).toBe('chunk-0');

    const result2 = await reader1.read();
    expect(result2.done).toBe(false);
    expect(result2.value).toBe('chunk-1');
    await delay(10);
    await deferred1.detachSource();

    // reader1 now done
    const result3 = await reader1.read();
    expect(result3.done).toBe(true);
    expect(result3.value).toBeUndefined();

    deferred2.setSource(source);
    const reader2 = deferred2.stream.getReader();
    const result4 = await reader2.read();
    expect(result4.done).toBe(false);
    expect(result4.value).toBe('chunk-2');

    const result5 = await reader2.read();
    expect(result5.done).toBe(false);
    expect(result5.value).toBe('chunk-3');

    const result6 = await reader2.read();
    expect(result6.done).toBe(true);
    expect(result6.value).toBeUndefined();

    reader1.releaseLock();
    reader2.releaseLock();
  });
});
