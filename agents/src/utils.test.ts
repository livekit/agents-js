// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../src/log.js';
import {
  Event,
  Task,
  TaskResult,
  asyncIterableToReadableStream,
  dedent,
  delay,
  isPending,
  readableStreamToAsyncIterable,
  resampleStream,
} from '../src/utils.js';

describe('utils', () => {
  // initialize logger
  initializeLogger({ pretty: true, level: 'debug' });

  describe('Task', () => {
    it('should execute task successfully and return result', async () => {
      const expectedResult = 'task completed';
      const task = Task.from(async () => {
        await delay(10);
        return expectedResult;
      });

      expect(task.done).toBe(false);
      const result = await task.result;
      expect(result).toBe(expectedResult);
      expect(task.done).toBe(true);
    });

    it('should handle task errors properly', async () => {
      const expectedError = new Error('Task failed');
      const task = Task.from(async () => {
        await delay(10);
        throw expectedError;
      });

      expect(task.done).toBe(false);
      await expect(task.result).rejects.toThrow(expectedError);
      expect(task.done).toBe(true);
    });

    it('should cancel task when cancel is called', async () => {
      let taskStarted = false;
      let taskCompleted = false;

      const task = Task.from(async (controller) => {
        taskStarted = true;
        await delay(100, { signal: controller.signal });
        taskCompleted = true;
        return 'should not complete';
      });

      // Wait a bit to ensure task starts
      await delay(10);
      expect(taskStarted).toBe(true);
      expect(task.done).toBe(false);

      // Cancel the task
      task.cancel();

      // The task should reject with AbortError
      try {
        await task.result;
      } catch (error: unknown) {
        expect((error as Error).name).toBe('AbortError');
      }

      expect(taskCompleted).toBe(false);
      expect(task.done).toBe(true);
    });

    it('should use provided AbortController', async () => {
      const controller = new AbortController();
      const task = Task.from(async (ctrl) => {
        expect(ctrl).toBe(controller);
        await delay(100, { signal: ctrl.signal });
        return 'completed';
      }, controller);

      await delay(10);
      controller.abort();

      try {
        await task.result;
      } catch (error: unknown) {
        expect((error as Error).name).toBe('AbortError');
      }

      expect(task.done).toBe(true);
    });

    it('should handle immediate resolution', async () => {
      const task = Task.from(async () => {
        return 'immediate';
      });

      const result = await task.result;
      expect(result).toBe('immediate');
      expect(task.done).toBe(true);
    });

    it('should handle immediate rejection', async () => {
      const expectedError = new Error('Immediate error');
      const task = Task.from(async () => {
        throw expectedError;
      });

      try {
        await task.result;
      } catch (error: unknown) {
        expect(error).toBe(expectedError);
      }

      expect(task.done).toBe(true);
    });

    it('should handle multiple calls to cancel', async () => {
      const task = Task.from(async (controller) => {
        await delay(100, { signal: controller.signal });
        return 'should not complete';
      });

      await delay(10);

      // Multiple cancellations should not cause issues
      task.cancel();
      task.cancel();
      task.cancel();

      try {
        await task.result;
      } catch (error: unknown) {
        expect((error as Error).name).toBe('AbortError');
      }

      expect(task.done).toBe(true);
    });

    it('should handle task that checks abort signal manually', async () => {
      const arr: number[] = [];
      const task = Task.from(async (controller) => {
        for (let i = 0; i < 10; i++) {
          if (controller.signal.aborted) {
            throw new Error('Task was aborted');
          }
          await delay(10);
          arr.push(i);
        }
        return 'completed';
      });

      await delay(35);
      task.cancel();

      expect(arr).toEqual([0, 1, 2]);
      try {
        await task.result;
      } catch (error: unknown) {
        expect((error as Error).message).toBe('Task was aborted');
      }

      expect(task.done).toBe(true);
    });

    it('should handle cleanup in finally block', async () => {
      let cleanupExecuted = false;

      const task = Task.from(async (controller) => {
        try {
          await delay(100, { signal: controller.signal });
          return 'completed';
        } finally {
          cleanupExecuted = true;
        }
      });

      await delay(10);
      task.cancel();

      try {
        await task.result;
      } catch {
        // Ignore the abort error
      }

      // Cleanup should still execute even when cancelled
      expect(cleanupExecuted).toBe(true);
    });

    it('should handle accessing result multiple times', async () => {
      const task = Task.from(async () => {
        await delay(10);
        return 'result';
      });

      const result1 = await task.result;
      const result2 = await task.result;
      const result3 = await task.result;

      expect(result1).toBe('result');
      expect(result2).toBe('result');
      expect(result3).toBe('result');
      expect(task.done).toBe(true);
    });

    it('should handle accessing result promise before completion', async () => {
      const task = Task.from(async () => {
        await delay(50);
        return 'delayed result';
      });

      // Get references to result promise before completion
      const resultPromise1 = task.result;
      const resultPromise2 = task.result;

      expect(task.done).toBe(false);

      // Both promises should resolve to the same value
      const [result1, result2] = await Promise.all([resultPromise1, resultPromise2]);

      expect(result1).toBe('delayed result');
      expect(result2).toBe('delayed result');
      expect(task.done).toBe(true);
    });

    it('should cancel child tasks when parent task is canceled', async () => {
      let parentStarted = false;
      let child1Started = false;
      let child2Started = false;
      let parentCompleted = false;
      let child1Completed = false;
      let child2Completed = false;

      let child1Task: Task<string> | undefined = undefined;
      let child2Task: Task<string> | undefined = undefined;

      const parentTask = Task.from(async (controller) => {
        parentStarted = true;

        // Create two child tasks using the parent's controller
        child1Task = Task.from(async (childController) => {
          child1Started = true;
          await delay(100, { signal: childController.signal });
          child1Completed = true;
          return 'child1';
        }, controller);

        child2Task = Task.from(async (childController) => {
          child2Started = true;
          await delay(100, { signal: childController.signal });
          child2Completed = true;
          return 'child2';
        }, controller);

        // Wait for both child tasks
        const results = await Promise.all([child1Task.result, child2Task.result]);
        parentCompleted = true;
        return results;
      });

      // Let tasks start
      await delay(20);

      // Verify tasks have started
      expect(parentStarted).toBe(true);
      expect(child1Started).toBe(true);
      expect(child2Started).toBe(true);

      // Cancel parent task
      parentTask.cancel();

      // Use Promise.allSettled to handle all promise settlements
      const [parentResult, child1Result, child2Result] = await Promise.allSettled([
        parentTask.result,
        child1Task!.result,
        child2Task!.result,
      ]);

      // Verify all tasks were rejected with AbortError
      expect(parentResult.status).toBe('rejected');
      expect((parentResult as PromiseRejectedResult).reason.name).toBe('AbortError');

      expect(child1Result.status).toBe('rejected');
      expect((child1Result as PromiseRejectedResult).reason.name).toBe('AbortError');

      expect(child2Result.status).toBe('rejected');
      expect((child2Result as PromiseRejectedResult).reason.name).toBe('AbortError');

      // Verify none of the tasks completed
      expect(parentCompleted).toBe(false);
      expect(child1Completed).toBe(false);
      expect(child2Completed).toBe(false);
      expect(parentTask.done).toBe(true);
      expect(child1Task!.done).toBe(true);
      expect(child2Task!.done).toBe(true);
    });

    it('should handle nested tasks that complete successfully', async () => {
      const results: string[] = [];

      const parentTask = Task.from(async (controller) => {
        results.push('parent-start');

        // Create first child task
        const child1Task = Task.from(async () => {
          results.push('child1-start');
          await delay(25);
          results.push('child1-end');
          return 'child1-result';
        }, controller);

        // Create second child task that depends on first
        const child2Task = Task.from(async (childController) => {
          results.push('child2-start');

          // Create a grandchild task
          const grandchildTask = Task.from(async () => {
            results.push('grandchild-start');
            await delay(10);
            results.push('grandchild-end');
            return 'grandchild-result';
          }, childController);

          const grandchildResult = await grandchildTask.result;
          await delay(10);
          results.push('child2-end');
          return `child2-result-with-${grandchildResult}`;
        }, controller);

        // Wait for all tasks
        const [child1Result, child2Result] = await Promise.all([
          child1Task.result,
          child2Task.result,
        ]);

        results.push('parent-end');
        return {
          parent: 'parent-result',
          child1: child1Result,
          child2: child2Result,
        };
      });

      // Wait for everything to complete
      const finalResult = await parentTask.result;

      // Verify results
      expect(finalResult).toEqual({
        parent: 'parent-result',
        child1: 'child1-result',
        child2: 'child2-result-with-grandchild-result',
      });

      // Verify execution order
      // Check important ordering constraints without being strict about parallel task ordering
      expect(results).toEqual([
        'parent-start',
        'child1-start',
        'child2-start',
        'grandchild-start',
        'grandchild-end',
        'child2-end',
        'child1-end',
        'parent-end',
      ]);

      // All tasks should be done
      expect(parentTask.done).toBe(true);
    });

    it('should propagate errors from nested tasks', async () => {
      let parentError: Error | null = null;
      let child1Completed = false;
      let child2Started = false;

      const parentTask = Task.from(async (controller) => {
        const child1Task = Task.from(async () => {
          await delay(20);
          throw new Error('child1 error');
        }, controller);

        const child2Task = Task.from(async () => {
          child2Started = true;
          await delay(30);
          child1Completed = true;
          return 'child2-result';
        }, controller);

        // This will throw when child1 fails
        const results = await Promise.all([child1Task.result, child2Task.result]);
        return results;
      });

      // Wait for the parent task to fail
      try {
        await parentTask.result;
        expect.fail('Parent task should have thrown');
      } catch (error: unknown) {
        parentError = error as Error;
      }

      // Verify the error propagated correctly
      expect(parentError?.message).toBe('child1 error');
      expect(child1Completed).toBe(false);
      expect(child2Started).toBe(true);
      expect(parentTask.done).toBe(true);
    });

    it('should cancel and wait for task completion', async () => {
      let taskCompleted = false;

      const task = Task.from(async (controller) => {
        await delay(5000, { signal: controller.signal });
        taskCompleted = true;
        return 'should not complete';
      });

      // Cancel and wait should complete quickly when task is aborted
      const start = Date.now();
      const result = await task.cancelAndWait(1000);
      const duration = Date.now() - start;

      expect(result).toBe(TaskResult.Aborted);
      expect(duration).toBeLessThan(100); // Should not wait for full timeout
      expect(taskCompleted).toBe(false);
      expect(task.done).toBe(true);
    });

    it('should timeout if task does not respond to cancellation', async () => {
      const task = Task.from(async () => {
        await delay(1000);
      });

      // This should timeout because the task ignores cancellation
      try {
        await task.cancelAndWait(200);
        expect.fail('Task should have timed out');
      } catch (error: unknown) {
        expect(error).instanceof(Error);
        expect((error as Error).message).toBe('Task cancellation timed out');
      }
    });

    it('should handle task that completes before timeout', async () => {
      const task = Task.from(async () => {
        await delay(50);
      });

      // Start the task
      await delay(10);

      // Cancel and wait - but task will complete normally before being canceled
      const result = await task.cancelAndWait(1000);

      // Task should have completed normally
      expect(result).toBe(TaskResult.Completed);
      expect(task.done).toBe(true);
    });

    it('should propagate non-abort errors from cancelAndWait', async () => {
      const task = Task.from(async () => {
        await delay(10);
        throw new TypeError('Custom error');
      });

      try {
        await task.cancelAndWait(1000);
        expect.fail('Task should have thrown');
      } catch (error: unknown) {
        expect((error as Error).message).toBe('Custom error');
        expect((error as Error).name).toBe('TypeError');
      }
    });

    it('should return undefined for Task.current outside task context', () => {
      expect(Task.current()).toBeUndefined();
    });

    it('should preserve Task.current inside a task across awaits', async () => {
      const task = Task.from(
        async () => {
          const currentAtStart = Task.current();
          await delay(5);
          const currentAfterAwait = Task.current();

          expect(currentAtStart).toBeDefined();
          expect(currentAfterAwait).toBe(currentAtStart);

          return currentAtStart;
        },
        undefined,
        'current-context-test',
      );

      const currentFromResult = await task.result;
      expect(currentFromResult).toBe(task);
    });

    it('should isolate nested Task.current context and restore parent context', async () => {
      const parentTask = Task.from(
        async (controller) => {
          const parentCurrent = Task.current();
          expect(parentCurrent).toBeDefined();

          const childTask = Task.from(
            async () => {
              const childCurrentStart = Task.current();
              await delay(5);
              const childCurrentAfterAwait = Task.current();

              expect(childCurrentStart).toBeDefined();
              expect(childCurrentAfterAwait).toBe(childCurrentStart);
              expect(childCurrentStart).not.toBe(parentCurrent);

              return childCurrentStart;
            },
            controller,
            'child-current-context-test',
          );

          const childCurrent = await childTask.result;
          const parentCurrentAfterChild = Task.current();

          expect(parentCurrentAfterChild).toBe(parentCurrent);

          return { parentCurrent, childCurrent };
        },
        undefined,
        'parent-current-context-test',
      );

      const { parentCurrent, childCurrent } = await parentTask.result;
      expect(parentCurrent).toBe(parentTask);
      expect(childCurrent).not.toBe(parentCurrent);
      expect(Task.current()).toBeUndefined();
    });

    it('should always expose Task.current for concurrent task callbacks', async () => {
      const tasks = Array.from({ length: 25 }, (_, idx) =>
        Task.from(
          async () => {
            const currentAtStart = Task.current();
            await delay(1);
            const currentAfterAwait = Task.current();

            expect(currentAtStart).toBeDefined();
            expect(currentAfterAwait).toBe(currentAtStart);

            return currentAtStart;
          },
          undefined,
          `current-context-stress-${idx}`,
        ),
      );

      const currentTasks = await Promise.all(tasks.map((task) => task.result));
      currentTasks.forEach((currentTask, idx) => {
        expect(currentTask).toBe(tasks[idx]);
      });
    });
  });

  describe('Event', () => {
    it('wait resolves immediately when the event is already set', async () => {
      const event = new Event();
      event.set();

      const result = await event.wait();
      expect(result).toBe(true);
    });

    it('wait resolves after set is called', async () => {
      // check promise is pending
      const event = new Event();
      const waiterPromise = event.wait();

      await delay(10);
      expect(await isPending(waiterPromise)).toBe(true);

      // check promise is resolved after set is called
      event.set();
      const result = await waiterPromise;
      expect(result).toBe(true);
    });

    it('all waiters resolve once set is called', async () => {
      const event = new Event();
      const waiters = [event.wait(), event.wait(), event.wait()];

      await delay(10);
      const pendings = await Promise.all(waiters.map((w) => isPending(w)));
      expect(pendings).toEqual([true, true, true]);

      event.set();
      const results = await Promise.all(waiters);
      expect(results).toEqual([true, true, true]);
    });

    it('wait after 2 seconds is still pending before set', async () => {
      const event = new Event();
      const waiter = event.wait();

      await delay(2000);
      expect(await isPending(waiter)).toBe(true);

      event.set();
      const result = await waiter;
      expect(result).toBe(true);
    });

    it('wait after set and clear should be pending', async () => {
      const event = new Event();
      const waiterBeforeSet = event.wait();
      event.set();
      event.clear();

      const waiterAfterSet = event.wait();

      const result = await Promise.race([
        waiterBeforeSet.then(() => 'before'),
        waiterAfterSet.then(() => 'after'),
      ]);

      expect(result).toBe('before');
      expect(await isPending(waiterBeforeSet)).toBe(false);
      expect(await isPending(waiterAfterSet)).toBe(true);

      event.set();
      expect(await waiterAfterSet).toBe(true);
    });
  });

  describe('dedent', () => {
    it('should remove common leading indentation', () => {
      const result = dedent`
        hello
        world
      `;
      expect(result).toBe('hello\nworld');
    });

    it('should preserve relative indentation', () => {
      const result = dedent`
        hello
          world
            nested
      `;
      expect(result).toBe('hello\n  world\n    nested');
    });

    it('should handle interpolations', () => {
      const name = 'world';
      const result = dedent`
        hello ${name}
        goodbye ${name}
      `;
      expect(result).toBe('hello world\ngoodbye world');
    });

    it('should handle empty lines in the middle', () => {
      const result = dedent`
        hello

        world
      `;
      expect(result).toBe('hello\n\nworld');
    });

    it('should handle single line', () => {
      const result = dedent`
        hello
      `;
      expect(result).toBe('hello');
    });

    it('should handle no indentation', () => {
      const result = dedent`
hello
world
`;
      expect(result).toBe('hello\nworld');
    });

    it('should handle tab indentation', () => {
      const result = dedent`
\t\thello
\t\t\tworld
\t\t`;
      expect(result).toBe('hello\n\tworld');
    });

    it('should handle empty string', () => {
      const result = dedent``;
      expect(result).toBe('');
    });

    it('should handle string with only whitespace', () => {
      const result = dedent`

      `;
      expect(result).toBe('');
    });

    it('should handle inline usage without leading newline', () => {
      const result = dedent`hello
        world`;
      expect(result).toBe('hello\n        world');
    });

    it('should handle interpolations that span values', () => {
      const a = 1;
      const b = 2;
      const result = dedent`
        sum: ${a + b}
        product: ${a * b}
      `;
      expect(result).toBe('sum: 3\nproduct: 2');
    });
  });

  describe('resampleStream', () => {
    const createAudioFrame = (sampleRate: number, samples: number, channels = 1): AudioFrame => {
      const data = new Int16Array(samples * channels);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.sin((i / samples) * Math.PI * 2) * 16000;
      }
      return new AudioFrame(data, sampleRate, channels, samples);
    };

    const streamToArray = async (stream: ReadableStream<AudioFrame>): Promise<AudioFrame[]> => {
      const reader = stream.getReader();
      const chunks: AudioFrame[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return chunks;
    };

    it('should resample audio frames to target sample rate', async () => {
      const inputRate = 48000;
      const outputRate = 16000;
      const inputFrame = createAudioFrame(inputRate, 960); // 20ms at 48kHz

      const inputStream = new ReadableStream<AudioFrame>({
        start(controller) {
          controller.enqueue(inputFrame);
          controller.close();
        },
      });

      const outputStream = resampleStream({ stream: inputStream, outputRate });
      const outputFrames = await streamToArray(outputStream);

      expect(outputFrames.length).toBeGreaterThan(0);

      for (const frame of outputFrames) {
        expect(frame.sampleRate).toBe(outputRate);
        expect(frame.channels).toBe(inputFrame.channels);
      }
    });

    it('should handle same input and output rate', async () => {
      const sampleRate = 44100;
      const inputFrame = createAudioFrame(sampleRate, 1024);

      const inputStream = new ReadableStream<AudioFrame>({
        start(controller) {
          controller.enqueue(inputFrame);
          controller.close();
        },
      });

      const outputStream = resampleStream({ stream: inputStream, outputRate: sampleRate });
      const outputFrames = await streamToArray(outputStream);

      expect(outputFrames.length).toBeGreaterThan(0);

      for (const frame of outputFrames) {
        expect(frame.sampleRate).toBe(sampleRate);
        expect(frame.channels).toBe(inputFrame.channels);
      }
    });

    it('should handle multiple input frames', async () => {
      const inputRate = 32000;
      const outputRate = 48000;
      const frame1 = createAudioFrame(inputRate, 640);
      const frame2 = createAudioFrame(inputRate, 640);

      const inputStream = new ReadableStream<AudioFrame>({
        start(controller) {
          controller.enqueue(frame1);
          controller.enqueue(frame2);
          controller.close();
        },
      });

      const outputStream = resampleStream({ stream: inputStream, outputRate });
      const outputFrames = await streamToArray(outputStream);

      expect(outputFrames.length).toBeGreaterThan(0);

      for (const frame of outputFrames) {
        expect(frame.sampleRate).toBe(outputRate);
        expect(frame.channels).toBe(frame1.channels);
      }
    });

    it('should handle empty stream', async () => {
      const inputStream = new ReadableStream<AudioFrame>({
        start(controller) {
          controller.close();
        },
      });

      const outputStream = resampleStream({ stream: inputStream, outputRate: 44100 });
      const outputFrames = await streamToArray(outputStream);

      expect(outputFrames).toEqual([]);
    });
  });

  describe('readableStreamToAsyncIterable', () => {
    it('should yield all values from a ReadableStream', async () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(1);
          controller.enqueue(2);
          controller.enqueue(3);
          controller.close();
        },
      });

      const result: number[] = [];
      for await (const value of readableStreamToAsyncIterable(stream)) {
        result.push(value);
      }
      expect(result).toEqual([1, 2, 3]);
    });

    it('should handle an empty stream', async () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.close();
        },
      });

      const result: number[] = [];
      for await (const value of readableStreamToAsyncIterable(stream)) {
        result.push(value);
      }
      expect(result).toEqual([]);
    });

    it('should stop when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const stream = new ReadableStream<number>({
        start(c) {
          c.enqueue(1);
          c.close();
        },
      });

      const result: number[] = [];
      for await (const value of readableStreamToAsyncIterable(stream, controller.signal)) {
        result.push(value);
      }
      expect(result).toEqual([]);
    });

    it('should stop iteration when signal is aborted mid-stream', async () => {
      const ac = new AbortController();
      let enqueueNext: ((v: number) => void) | null = null;

      const stream = new ReadableStream<number>({
        start(controller) {
          let n = 0;
          enqueueNext = (v: number) => {
            n++;
            if (n > 10) {
              controller.close();
              return;
            }
            controller.enqueue(v);
          };
        },
      });

      const result: number[] = [];
      const iterPromise = (async () => {
        for await (const value of readableStreamToAsyncIterable(stream, ac.signal)) {
          result.push(value);
        }
      })();

      enqueueNext!(1);
      enqueueNext!(2);
      await delay(10);
      ac.abort();
      await iterPromise;

      expect(result).toEqual([1, 2]);
    });

    it('should handle stream errors by propagating them', async () => {
      let pullCount = 0;
      const stream = new ReadableStream<number>({
        pull(controller) {
          pullCount++;
          if (pullCount === 1) {
            controller.enqueue(1);
          } else {
            controller.error(new Error('stream broke'));
          }
        },
      });

      const result: number[] = [];
      await expect(async () => {
        for await (const value of readableStreamToAsyncIterable(stream)) {
          result.push(value);
        }
      }).rejects.toThrow('stream broke');
      expect(result).toEqual([1]);
    });

    it('should release the reader lock after iteration completes', async () => {
      const stream = new ReadableStream<number>({
        start(controller) {
          controller.enqueue(42);
          controller.close();
        },
      });

      const result: number[] = [];
      for await (const value of readableStreamToAsyncIterable(stream)) {
        result.push(value);
      }

      const reader = stream.getReader();
      const { done } = await reader.read();
      expect(done).toBe(true);
      reader.releaseLock();
    });

    it('should release the reader lock after abort', async () => {
      const ac = new AbortController();
      let enqueue: ((v: number) => void) | null = null;

      const stream = new ReadableStream<number>({
        start(controller) {
          enqueue = (v) => controller.enqueue(v);
        },
      });

      const iterPromise = (async () => {
        for await (const _ of readableStreamToAsyncIterable(stream, ac.signal)) {
          // consume
        }
      })();

      enqueue!(1);
      await delay(10);
      ac.abort();
      await iterPromise;

      const reader = stream.getReader();
      reader.releaseLock();
    });
  });

  describe('asyncIterableToReadableStream', () => {
    it('should produce all values from an async iterable', async () => {
      async function* gen() {
        yield 'a';
        yield 'b';
        yield 'c';
      }

      const stream = asyncIterableToReadableStream(gen());
      const reader = stream.getReader();
      const result: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result.push(value);
      }
      reader.releaseLock();
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should handle an empty async iterable', async () => {
      async function* gen(): AsyncGenerator<number> {
        // yields nothing
      }

      const stream = asyncIterableToReadableStream(gen());
      const reader = stream.getReader();
      const { done } = await reader.read();
      expect(done).toBe(true);
      reader.releaseLock();
    });

    it('should run generator finally block when stream is cancelled', async () => {
      let finallyCalled = false;

      async function* gen() {
        try {
          yield 1;
          yield 2;
          await delay(5000);
          yield 3;
        } finally {
          finallyCalled = true;
        }
      }

      const stream = asyncIterableToReadableStream(gen());
      const reader = stream.getReader();

      const { value: first } = await reader.read();
      expect(first).toBe(1);

      await reader.cancel();
      expect(finallyCalled).toBe(true);
    });

    it('should stop yielding after stream cancel', async () => {
      let yieldCount = 0;

      async function* gen() {
        while (true) {
          yieldCount++;
          yield yieldCount;
          await delay(10);
        }
      }

      const stream = asyncIterableToReadableStream(gen());
      const reader = stream.getReader();

      await reader.read();
      await reader.read();
      const countBeforeCancel = yieldCount;
      await reader.cancel();

      await delay(50);
      expect(yieldCount).toBe(countBeforeCancel);
    });

    it('should propagate generator errors to the stream reader', async () => {
      async function* gen() {
        yield 1;
        throw new Error('generator failed');
      }

      const stream = asyncIterableToReadableStream(gen());
      const reader = stream.getReader();

      const { value } = await reader.read();
      expect(value).toBe(1);

      await expect(reader.read()).rejects.toThrow('generator failed');
    });

    it('round-trip: stream → iterable → stream preserves values', async () => {
      const original = new ReadableStream<string>({
        start(controller) {
          controller.enqueue('x');
          controller.enqueue('y');
          controller.enqueue('z');
          controller.close();
        },
      });

      const iterable = readableStreamToAsyncIterable(original);
      const rebuilt = asyncIterableToReadableStream(iterable);

      const reader = rebuilt.getReader();
      const result: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result.push(value);
      }
      reader.releaseLock();
      expect(result).toEqual(['x', 'y', 'z']);
    });

    it('round-trip: cancel on rebuilt stream stops the original', async () => {
      let finallyCalled = false;

      async function* gen() {
        try {
          let i = 0;
          while (true) {
            yield i++;
            await delay(10);
          }
        } finally {
          finallyCalled = true;
        }
      }

      const stream = asyncIterableToReadableStream(gen());
      const iterable = readableStreamToAsyncIterable(stream);
      const rebuilt = asyncIterableToReadableStream(iterable);

      const reader = rebuilt.getReader();
      await reader.read();
      await reader.read();
      await reader.cancel();

      await delay(20);
      expect(finallyCalled).toBe(true);
    });
  });
});
