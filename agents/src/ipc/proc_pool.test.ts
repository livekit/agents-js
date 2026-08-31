// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Throws } from '@livekit/throws-transformer/throws';
import { describe, expect, it, vi } from 'vitest';
import type { RunningJobInfo } from '../job.js';
import { type JobExecutor, JobStatus } from './job_executor.js';
import * as jobProcExecutorModule from './job_proc_executor.js';
import { ProcPool } from './proc_pool.js';

function createMockExecutor() {
  const executor: JobExecutor = {
    started: true,
    userArguments: {},
    runningJob: undefined,
    status: JobStatus.RUNNING,
    start: vi.fn(async () => {}),
    join: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    launchJob: vi.fn(async () => {}),
  };
  return executor;
}

/** Flush the microtask queue enough times for an async chain to settle. */
async function flushMicrotasks(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

function createControlledJoinExecutor() {
  let resolveJoin: () => void = () => {};
  const joinPromise = new Promise<void>((resolve) => {
    resolveJoin = resolve;
  });
  const executor: JobExecutor = {
    ...createMockExecutor(),
    join: vi.fn(() => joinPromise),
  };
  return { executor, resolveJoin };
}

function mockJobProcExecutor(executor: JobExecutor) {
  return vi
    .spyOn(jobProcExecutorModule, 'JobProcExecutor')
    .mockImplementation(function MockJobProcExecutor(this: unknown) {
      return executor as unknown as jobProcExecutorModule.JobProcExecutor;
    } as unknown as typeof jobProcExecutorModule.JobProcExecutor);
}

describe('ProcPool warmed process lock handling', () => {
  it('releases lock token from the dequeued warmed process entry', async (): Promise<
    Throws<void, Error>
  > => {
    const pool = new ProcPool('agent', 1, 1000, 1000, undefined, 0, 0);
    const unlock = vi.fn();
    const executor = createMockExecutor();
    const jobInfo = {
      acceptArguments: { name: 'n', identity: 'i', metadata: '' },
      job: { id: 'job-id' },
      url: 'wss://example.com',
      token: 'token',
      workerId: 'worker-id',
    } as unknown as RunningJobInfo;

    await pool.warmedProcQueue.put({ proc: executor, unlock });
    await pool.launchJob(jobInfo);

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(executor.launchJob).toHaveBeenCalledWith(jobInfo);
  });

  it('releases queued lock tokens during close', async () => {
    const pool = new ProcPool('agent', 1, 1000, 1000, undefined, 0, 0);
    const unlock = vi.fn();
    const executor = createMockExecutor();

    await pool.warmedProcQueue.put({ proc: executor, unlock });
    pool.started = true;
    await pool.close();

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(executor.close).toHaveBeenCalledTimes(1);
  });

  it('releases both init and proc locks when closed before proc starts', async () => {
    const pool = new ProcPool('agent', 1, 1000, 1000, undefined, 0, 0);
    const initUnlock = vi.fn();
    const procUnlock = vi.fn();
    pool.closed = true;
    pool.initMutex.lock = vi.fn(async () => initUnlock);

    await pool.procWatchTask(procUnlock);

    expect(initUnlock).toHaveBeenCalledTimes(1);
    expect(procUnlock).toHaveBeenCalledTimes(1);
  });

  it('releases initMutex after warming so concurrent procWatchTasks can initialise', async (): Promise<
    Throws<void, Error>
  > => {
    // Regression: initMutex must be released after enqueue, not after join().
    // Child procs are one-shot, so holding initMutex through join() serialises
    // the pool to effective concurrency 1 regardless of numIdleProcesses.
    const pool = new ProcPool('agent', 1, 1000, 1000, undefined, 0, 0);
    const initUnlock = vi.fn();
    const procUnlock = vi.fn();
    const { executor: mockProc, resolveJoin } = createControlledJoinExecutor();
    const jobProcExecutorSpy = mockJobProcExecutor(mockProc);

    pool.initMutex.lock = vi.fn(async () => initUnlock);

    try {
      const watchPromise = pool.procWatchTask(procUnlock);
      await flushMicrotasks();

      // initMutex released while proc.join() is still pending.
      expect(initUnlock).toHaveBeenCalledTimes(1);
      expect(pool.warmedProcQueue.items.length).toBe(1);
      expect(mockProc.join).toHaveBeenCalledTimes(1);

      const warmedProcEntry = await pool.warmedProcQueue.get();
      warmedProcEntry.unlock();
      resolveJoin();
      await watchPromise;

      // The watcher must not release a lock token already claimed by a consumer.
      expect(initUnlock).toHaveBeenCalledTimes(1);
      expect(procUnlock).toHaveBeenCalledTimes(1);
    } finally {
      jobProcExecutorSpy.mockRestore();
    }
  });

  it('evicts a warmed process that exits before it is dequeued', async (): Promise<
    Throws<void, Error>
  > => {
    const pool = new ProcPool('agent', 1, 1000, 1000, undefined, 0, 0);
    const initUnlock = vi.fn();
    const procUnlock = vi.fn();
    const { executor: mockProc, resolveJoin } = createControlledJoinExecutor();
    const jobProcExecutorSpy = mockJobProcExecutor(mockProc);

    pool.initMutex.lock = vi.fn(async () => initUnlock);

    try {
      const watchPromise = pool.procWatchTask(procUnlock);
      await flushMicrotasks();

      expect(pool.warmedProcQueue.items).toHaveLength(1);

      resolveJoin();
      await watchPromise;

      expect(pool.warmedProcQueue.items).toHaveLength(0);
      expect(procUnlock).toHaveBeenCalledTimes(1);
    } finally {
      jobProcExecutorSpy.mockRestore();
    }
  });

  it('keeps other warmed processes queued when one exits', async (): Promise<
    Throws<void, Error>
  > => {
    const pool = new ProcPool('agent', 2, 1000, 1000, undefined, 0, 0);
    const initUnlock = vi.fn();
    const healthyProcUnlock = vi.fn();
    const exitedProcUnlock = vi.fn();
    const healthyProc = createMockExecutor();
    const { executor: exitedProc, resolveJoin } = createControlledJoinExecutor();
    const jobProcExecutorSpy = mockJobProcExecutor(exitedProc);

    pool.initMutex.lock = vi.fn(async () => initUnlock);
    await pool.warmedProcQueue.put({ proc: healthyProc, unlock: healthyProcUnlock });

    try {
      const watchPromise = pool.procWatchTask(exitedProcUnlock);
      await flushMicrotasks();

      expect(pool.warmedProcQueue.items).toHaveLength(2);

      resolveJoin();
      await watchPromise;

      expect(pool.warmedProcQueue.items).toEqual([
        { proc: healthyProc, unlock: healthyProcUnlock },
      ]);
      expect(exitedProcUnlock).toHaveBeenCalledTimes(1);
      expect(healthyProcUnlock).not.toHaveBeenCalled();
    } finally {
      jobProcExecutorSpy.mockRestore();
    }
  });

  it('does not double-release a queued process lock during close', async (): Promise<
    Throws<void, Error>
  > => {
    const pool = new ProcPool('agent', 1, 1000, 1000, undefined, 0, 0);
    const initUnlock = vi.fn();
    const procUnlock = vi.fn();
    const { executor: mockProc, resolveJoin } = createControlledJoinExecutor();
    const jobProcExecutorSpy = mockJobProcExecutor(mockProc);

    pool.initMutex.lock = vi.fn(async () => initUnlock);
    pool.started = true;

    try {
      const watchPromise = pool.procWatchTask(procUnlock);
      await flushMicrotasks();

      const closePromise = pool.close();
      expect(pool.warmedProcQueue.items).toHaveLength(0);

      resolveJoin();
      await Promise.all([closePromise, watchPromise]);

      expect(procUnlock).toHaveBeenCalledTimes(1);
    } finally {
      jobProcExecutorSpy.mockRestore();
    }
  });

  it('releases initMutex in finally when initialization fails before enqueue', async (): Promise<
    Throws<void, Error>
  > => {
    const pool = new ProcPool('agent', 1, 1000, 1000, undefined, 0, 0);
    const initUnlock = vi.fn();
    const procUnlock = vi.fn();

    const mockProc: JobExecutor = {
      ...createMockExecutor(),
      initialize: vi.fn(async () => {
        throw new Error('simulated initialization failure');
      }),
    };

    const jobProcExecutorSpy = vi
      .spyOn(jobProcExecutorModule, 'JobProcExecutor')
      .mockImplementation(function MockJobProcExecutor(this: unknown) {
        return mockProc as unknown as jobProcExecutorModule.JobProcExecutor;
      } as unknown as typeof jobProcExecutorModule.JobProcExecutor);

    pool.initMutex.lock = vi.fn(async () => initUnlock);

    try {
      await pool.procWatchTask(procUnlock);

      expect(initUnlock).toHaveBeenCalledTimes(1);
      expect(procUnlock).toHaveBeenCalledTimes(1);
      expect(pool.warmedProcQueue.items.length).toBe(0);
    } finally {
      jobProcExecutorSpy.mockRestore();
    }
  });
});
