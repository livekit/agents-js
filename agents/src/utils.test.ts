// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../src/log.js';
import {
  Event,
  TASK_TIMEOUT_ERROR,
  Task,
  TaskResult,
  delay,
  isPending,
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

      await delay(39);
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
        expect(error).toBe(TASK_TIMEOUT_ERROR);
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
});
