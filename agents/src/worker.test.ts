// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job } from '@livekit/protocol';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { type JobExecutor, JobStatus } from './ipc/job_executor.js';
import { JobProcExecutor } from './ipc/job_proc_executor.js';
import { ProcPool } from './ipc/proc_pool.js';
import { Future } from './utils.js';
import { AgentServer, ServerOptions } from './worker.js';

vi.mock('./inference/_warmup.js', () => ({
  _getLocalInferenceModule: () => undefined,
}));

describe('AgentServer connection failures', () => {
  it('run rejects when connection retries are exhausted', async () => {
    const server = new AgentServer(
      new ServerOptions({
        agent: 'test-agent.js',
        wsURL: 'ws://127.0.0.1:1',
        apiKey: 'devkey',
        apiSecret: 'devsecret',
        maxRetry: 0,
        numIdleProcesses: 0,
        simulation: true,
      }),
    );

    try {
      await expect(server.run()).rejects.toThrow(/failed to connect/);
    } finally {
      await server.close();
      await server.close();
    }
  });
});

describe('AgentServer drain', () => {
  it.each([0, 3_600_000])(
    'waits for active jobs when the pool has an unstarted process (timeout %i)',
    async (drainTimeout) => {
      const jobFinished = new Future();
      const activeProc: JobExecutor = {
        started: true,
        userArguments: {},
        runningJob: {
          job: new Job({ id: 'active-job' }),
          acceptArguments: { name: 'test', identity: 'test', metadata: '' },
          url: 'ws://localhost',
          token: 'test-token',
          workerId: 'test-worker',
        },
        status: JobStatus.RUNNING,
        start: vi.fn(async () => {}),
        initialize: vi.fn(async () => {}),
        launchJob: vi.fn(async () => {}),
        join: vi.fn(() => jobFinished.await),
        close: vi.fn(async () => {}),
      };
      const unstartedProc = new JobProcExecutor({
        agent: 'test-agent.js',
        initializeTimeout: 1000,
        closeTimeout: 1000,
        memoryWarnMB: 0,
        memoryLimitMB: 0,
        pingInterval: 2500,
        pingTimeout: 60_000,
        highPingThreshold: 500,
      });
      const processes = vi
        .spyOn(ProcPool.prototype, 'processes', 'get')
        .mockReturnValue([activeProc, unstartedProc]);
      const server = new AgentServer(
        new ServerOptions({
          agent: 'test-agent.js',
          wsURL: 'ws://localhost',
          apiKey: 'devkey',
          apiSecret: 'devsecret',
          numIdleProcesses: 0,
          drainTimeout,
          simulation: true,
        }),
      );

      const drain = server.drain();
      try {
        await expect(
          Promise.race([drain.then(() => 'drained'), setImmediate('pending')]),
        ).resolves.toBe('pending');
        expect(activeProc.join).toHaveBeenCalledOnce();
        expect(activeProc.close).not.toHaveBeenCalled();

        jobFinished.resolve();
        await expect(drain).resolves.toBeUndefined();
      } finally {
        jobFinished.resolve();
        await drain.catch(() => undefined);
        processes.mockRestore();
      }
    },
  );
});

describe('ServerOptions sessionEndTimeout', () => {
  it('defaults to five minutes', () => {
    const options = new ServerOptions({ agent: 'test-agent.js' });
    expect(options.sessionEndTimeout).toBe(300_000);
  });

  it('accepts an override', () => {
    const options = new ServerOptions({
      agent: 'test-agent.js',
      sessionEndTimeout: 12_345,
    });
    expect(options.sessionEndTimeout).toBe(12_345);
  });

  it.each([-1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])(
    'rejects invalid value %s',
    (sessionEndTimeout) => {
      expect(() => new ServerOptions({ agent: 'test-agent.js', sessionEndTimeout })).toThrow(
        'sessionEndTimeout must be a finite, non-negative number',
      );
    },
  );

  it('rejects values above the Node.js timer limit', () => {
    expect(
      () => new ServerOptions({ agent: 'test-agent.js', sessionEndTimeout: 2_147_483_648 }),
    ).toThrow('sessionEndTimeout must not exceed 2147483647 milliseconds');
  });
});
