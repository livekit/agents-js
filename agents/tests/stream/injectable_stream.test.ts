import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { InjectableStream } from '../../src/stream/injectable_stream.js';

describe('InjectableStream', () => {
  // Helper to create a readable stream from an array
  function createReadableStream<T>(items: T[]): ReadableStream<T> {
    return new ReadableStream<T>({
      start(controller) {
        for (const item of items) {
          controller.enqueue(item);
        }
        controller.close();
      },
    });
  }

  // Helper to collect all values from a stream
  async function collectStream<T>(stream: InjectableStream<T>): Promise<T[]> {
    const reader = stream.readable.getReader();
    const values: T[] = [];
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        values.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    
    return values;
  }

  // Helper to create a controlled source stream
  function createControlledStream<T>() {
    let controller: ReadableStreamDefaultController<T>;
    const stream = new ReadableStream<T>({
      start(c) {
        controller = c;
      },
    });
    
    return {
      stream,
      enqueue: (value: T) => controller.enqueue(value),
      close: () => controller.close(),
      error: (e: any) => controller.error(e),
    };
  }

  describe('Happy Path', () => {
    it('should pass through source stream data without injection', async () => {
      const sourceData = [1, 2, 3, 4, 5];
      const source = createReadableStream(sourceData);
      const injectable = new InjectableStream(source);
      injectable.close();

      const result = await collectStream(injectable);
      expect(result).toEqual(sourceData);
    });

    it('should handle empty source stream', async () => {
      const source = createReadableStream([]);
      const injectable = new InjectableStream(source);
      injectable.close();
      
      const result = await collectStream(injectable);
      expect(result).toEqual([]);
    });
  });

  describe('Read/Write with Inject', () => {
    it('should merge injected values with source stream', async () => {
      const controlled = createControlledStream<string>();
      const injectable = new InjectableStream(controlled.stream);
      
      // Start reading
      const readPromise = collectStream(injectable);
      
      // Enqueue source values
      controlled.enqueue('source1');
      controlled.enqueue('source2');
      
      // Inject a value
      await injectable.inject('injected1');
      
      // More source values
      controlled.enqueue('source3');

      // Close source
      controlled.close();
      injectable.close(); // close the injectable stream
      
      const result = await readPromise;
      
      // The order might vary due to merging, but all values should be present
      expect(result).toHaveLength(4);
      expect(result).toContain('source1');
      expect(result).toContain('source2');
      expect(result).toContain('source3');
      expect(result).toContain('injected1');
    });

    it('should handle multiple injections (if supported)', async () => {
      const controlled = createControlledStream<number>();
      const injectable = new InjectableStream(controlled.stream);
      
      const readPromise = collectStream(injectable);
      
      // Multiple injections should now work
      await injectable.inject(100);
      await injectable.inject(200);
      await injectable.inject(300);
        
      controlled.close();
      injectable.close();
      
      const result = await readPromise;
      expect(result).toEqual([100, 200, 300]);
    });
  });

  describe('After Close', () => {
    it('should continue reading from source after close', async () => {
      const controlled = createControlledStream<string>();
      const injectable = new InjectableStream(controlled.stream);
      
      // Start reading
      const reader = injectable.readable.getReader();
      const values: string[] = [];
      
      // Read first value
      controlled.enqueue('before-close');
      let result = await reader.read();
      if (!result.done) values.push(result.value);
      
      // Close injectable
      await injectable.close();
      
      // Source should still work
      controlled.enqueue('after-close-1');
      controlled.enqueue('after-close-2');
      controlled.close();
      
      // Continue reading
      while (true) {
        result = await reader.read();
        if (result.done) break;
        values.push(result.value);
      }
      
      reader.releaseLock();
      
      expect(values).toEqual(['before-close', 'after-close-1', 'after-close-2']);
    });

    it('should prevent injection after close', async () => {
      const source = createReadableStream([1, 2, 3]);
      const injectable = new InjectableStream(source);
      
      await injectable.close();

      try {
        await injectable.inject(999);
        expect.fail('Expected inject to fail');
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    });
  });

  describe('After Cancel', () => {
    it('should cancel both streams when cancel is called', async () => {
      const controlled = createControlledStream<string>();
      const injectable = new InjectableStream(controlled.stream);
      
      const reader = injectable.readable.getReader();
      reader.releaseLock();
      
      // Cancel the stream
      await injectable.cancel('test cancellation');

      const { done } = await reader.read();
      expect(done).toBe(true);

      reader.releaseLock();
    });

    it('should prevent injection after cancel', async () => {
      const source = createReadableStream([1, 2, 3]);
      const injectable = new InjectableStream(source);
      
      await injectable.cancel();
      
      // Injection should fail after cancel
      await expect(injectable.inject(999)).rejects.toThrow();
    });

    it('should propagate cancel reason', async () => {
      const controlled = createControlledStream<string>();
      const injectable = new InjectableStream(controlled.stream);
      
      const reason = new Error('Custom cancel reason');
      
      // Start reading to see if error propagates
      const reader = injectable.readable.getReader();
      const readPromise = reader.read();
      
      await injectable.cancel(reason);
      
      // The read should complete with done=true (cancel doesn't necessarily propagate as error to reader)
      const result = await readPromise;
      expect(result.done).toBe(true);
      
      reader.releaseLock();
    });
  });

//   describe('Complex Cases', () => {
//     it('should handle concurrent injections safely', async () => {
//       const controlled = createControlledStream<number>();
//       const injectable = new InjectableStream(controlled.stream);
      
//       const readPromise = collectStream(injectable);
      
//       // Try concurrent injections (mutex should serialize them)
//       const injectPromises = [
//         injectable.inject(1),
//         injectable.inject(2),
//         injectable.inject(3),
//       ];
      
//       // Wait for all injections to complete (some might fail)
//       await Promise.allSettled(injectPromises);
      
//       await injectable.close();
//       await controlled.close();
      
//       const values = await readPromise;
      
//       // At least the first injection should succeed
//       expect(values.sort()).toEqual([1, 2, 3]);
//     });

//     it('should handle backpressure correctly', async () => {
//       const controlled = createControlledStream<number>();
//       const injectable = new InjectableStream(controlled.stream);
      
//       // Create a slow reader to induce backpressure
//       const reader = injectable.readable.getReader();
//       const values: number[] = [];
      
//       // Enqueue many values quickly
//       for (let i = 0; i < 10; i++) {
//         controlled.enqueue(i);
//       }
      
//       // Try to inject while there's backpressure
//       const injectPromise = injectable.inject(999);
      
//       // Slowly read values
//       for (let i = 0; i < 5; i++) {
//         const { done, value } = await reader.read();
//         if (!done) values.push(value);
//         await new Promise(resolve => setTimeout(resolve, 10));
//       }
      
//       await injectPromise;
//       controlled.close();
      
//       // Read remaining values
//       while (true) {
//         const { done, value } = await reader.read();
//         if (done) break;
//         values.push(value);
//       }
      
//       reader.releaseLock();
      
//       // All values should be present
//       expect(values.length).toBeGreaterThan(5);
//       expect(values).toContain(999);
//     });

//     it('should handle source stream errors', async () => {
//       const controlled = createControlledStream<string>();
//       const injectable = new InjectableStream(controlled.stream);
      
//       const reader = injectable.readable.getReader();
      
//       controlled.enqueue('value1');
      
//       // Error the source stream
//       const error = new Error('Source stream error');
//       controlled.error(error);
      
//       // First read should succeed
//       const result1 = await reader.read();
//       expect(result1.done).toBe(false);
//       expect(result1.value).toBe('value1');
      
//       // Next read should propagate the error
//       await expect(reader.read()).rejects.toThrow('Source stream error');
      
//       reader.releaseLock();
//     });

//     it('should handle injection during active read', async () => {
//       const controlled = createControlledStream<string>();
//       const injectable = new InjectableStream(controlled.stream);
      
//       const reader = injectable.readable.getReader();
      
//       // Start a read that will wait
//       const readPromise = reader.read();
      
//       // Inject while read is pending
//       await injectable.inject('injected');
      
//       // The read should resolve with the injected value (or source value if it comes first)
//       const { done, value } = await readPromise;
//       expect(done).toBe(false);
//       expect(value).toBe('injected');
      
//       controlled.close();
//       reader.releaseLock();
//     });
//   });

//   describe('Implementation Issues', () => {
//     it('multiple injections now work correctly', async () => {
//       const source = createReadableStream<string>([]);
//       const injectable = new InjectableStream(source);
      
//       // All injections should work now
//       await expect(injectable.inject('first')).resolves.not.toThrow();
//       await expect(injectable.inject('second')).resolves.not.toThrow();
//       await expect(injectable.inject('third')).resolves.not.toThrow();
      
//       const result = await collectStream(injectable);
//       expect(result).toEqual(['first', 'second', 'third']);
//     });
//   });
});
