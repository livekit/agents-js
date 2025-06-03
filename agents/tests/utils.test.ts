// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { delay } from '@std/async';
import { describe, expect, it } from 'vitest';
import { createTask } from '../src/utils.js';

describe('AbortableTask', () => {
  describe('createTask', () => {
    it('should execute task successfully and return result', async () => {
      const expectedResult = 'task completed';
      const task = createTask(async () => {
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
      const task = createTask(async () => {
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

      const task = createTask(async (controller) => {
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
      } catch (error: any) {
        expect(error.name).toBe('AbortError');
      }

      expect(taskCompleted).toBe(false);
      expect(task.done).toBe(true);
    });

    it('should use provided AbortController', async () => {
      const controller = new AbortController();
      const task = createTask(async (ctrl) => {
        expect(ctrl).toBe(controller);
        await delay(100, { signal: ctrl.signal });
        return 'completed';
      }, controller);

      await delay(10);
      controller.abort();

      try {
        await task.result;
      } catch (error: any) {
        expect(error.name).toBe('AbortError');
      }

      expect(task.done).toBe(true);
    });

    it('should handle immediate resolution', async () => {
      const task = createTask(async () => {
        return 'immediate';
      });

      const result = await task.result;
      expect(result).toBe('immediate');
      expect(task.done).toBe(true);
    });

    it('should handle immediate rejection', async () => {
      const expectedError = new Error('Immediate error');
      const task = createTask(async () => {
        throw expectedError;
      });

      try {
        await task.result;
      } catch (error: any) {
        expect(error).toBe(expectedError);
      }

      expect(task.done).toBe(true);
    });

    it('should handle multiple calls to cancel', async () => {
      const task = createTask(async (controller) => {
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
      } catch (error: any) {
        expect(error.name).toBe('AbortError');
      }

      expect(task.done).toBe(true);
    });

    it('should handle task that checks abort signal manually', async () => {
      const arr: number[] = [];
      const task = createTask(async (controller) => {
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
      } catch (error: any) {
        expect(error.message).toBe('Task was aborted');
      }

      expect(task.done).toBe(true);
    });

    it('should handle cleanup in finally block', async () => {
      let cleanupExecuted = false;

      const task = createTask(async (controller) => {
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
      const task = createTask(async () => {
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
      const task = createTask(async () => {
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

      let child1Task: any;
      let child2Task: any;

      const parentTask = createTask(async (controller) => {
        parentStarted = true;

        // Create two child tasks using the parent's controller
        child1Task = createTask(async (childController) => {
          child1Started = true;
          await delay(100, { signal: childController.signal });
          child1Completed = true;
          return 'child1';
        }, controller);

        child2Task = createTask(async (childController) => {
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
        child1Task.result,
        child2Task.result
      ]);

      // Verify all tasks were rejected with AbortError
      expect(parentResult.status).toBe('rejected');
      expect((parentResult as any).reason.name).toBe('AbortError');

      expect(child1Result.status).toBe('rejected');
      expect((child1Result as any).reason.name).toBe('AbortError');

      expect(child2Result.status).toBe('rejected');
      expect((child2Result as any).reason.name).toBe('AbortError');

      // Verify none of the tasks completed
      expect(parentCompleted).toBe(false);
      expect(child1Completed).toBe(false);
      expect(child2Completed).toBe(false);
      expect(parentTask.done).toBe(true);
      expect(child1Task.done).toBe(true);
      expect(child2Task.done).toBe(true);
    });
  });
});
