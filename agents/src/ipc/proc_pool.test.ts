// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Throws } from '@livekit/throws-transformer/throws';
import { describe, expect, it, vi } from 'vitest';
import type { RunningJobInfo } from '../job.js';
import { type JobExecutor, JobStatus } from './job_executor.js';
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
});
