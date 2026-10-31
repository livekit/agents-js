// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job, JobJoinTiming } from '@livekit/protocol';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RunningJobInfo } from '../job.js';
import { initializeLogger } from '../log.js';
import type { Future } from '../utils.js';
import { JobStatus } from './job_executor.js';
import { JobProcExecutor } from './job_proc_executor.js';

initializeLogger({ pretty: false, level: 'silent' });

function executor(onJoinTiming?: (timing: JobJoinTiming) => void): JobProcExecutor {
  return new JobProcExecutor({
    agent: 'agent',
    initializeTimeout: 1000,
    closeTimeout: 1000,
    memoryWarnMB: 0,
    memoryLimitMB: 0,
    pingInterval: 2500,
    pingTimeout: 60000,
    highPingThreshold: 500,
    onJoinTiming,
  });
}

describe('JobProcExecutor', () => {
  it('forwards the join instants from the job process', async () => {
    const onJoinTiming = vi.fn();
    const exec = executor(onJoinTiming);
    const child = new EventEmitter() as unknown as ChildProcess;
    await exec.mainTask(child);

    const timing = new JobJoinTiming({ acceptedUs: 7n, connectedUs: 9n });
    child.emit('message', { case: 'joinTiming', value: timing.toJson() });

    expect(onJoinTiming).toHaveBeenCalledExactlyOnceWith(timing);
  });

  it.each([
    [0, JobStatus.SUCCESS],
    [1, JobStatus.FAILED],
    // killed: no exit code
    [null, JobStatus.FAILED],
  ])('ends a job whose process exited with code %s as %s', async (exitCode, status) => {
    const exec = executor();
    exec.proc = { exitCode, send: vi.fn() } as unknown as ChildProcess;
    (exec as unknown as { init: Future }).init.resolve();
    await exec.launchJob({
      acceptArguments: { name: 'n', identity: 'i', metadata: '' },
      job: new Job({ id: 'AJ_1' }),
      url: 'wss://example.com',
      token: 'token',
      workerId: 'W_1',
    } as RunningJobInfo);
    expect(exec.status).toBe(JobStatus.RUNNING);

    await exec.join();
    expect(exec.status).toBe(status);
  });
});
