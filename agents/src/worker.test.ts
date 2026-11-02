// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  Job,
  JobState,
  type MigrateJobRequest,
  RegisterWorkerResponse,
  ServerMessage,
  WorkerMessage,
  WorkerStatus,
} from '@livekit/protocol';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
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

  it('keeps reporting status while draining', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, 'listening');
    const registered = new Future();
    let fullUpdates = 0;
    let onFullUpdate = () => {};
    wss.on('connection', (ws) => {
      ws.on('message', (data: Buffer) => {
        const msg = WorkerMessage.fromBinary(new Uint8Array(data));
        if (msg.message.case === 'register') {
          const res = new RegisterWorkerResponse({ workerId: 'AW_test' });
          ws.send(new ServerMessage({ message: { case: 'register', value: res } }).toBinary());
          registered.resolve();
        } else if (
          msg.message.case === 'updateWorker' &&
          msg.message.value.status === WorkerStatus.WS_FULL
        ) {
          fullUpdates++;
          onFullUpdate();
        }
      });
    });

    const jobFinished = new Future();
    const activeProc: JobExecutor = {
      started: true,
      userArguments: {},
      runningJob: {
        job: new Job({ id: 'AJ_running' }),
        acceptArguments: { name: 'test', identity: 'test', metadata: '' },
        url: 'ws://localhost',
        token: 'test-token',
        workerId: 'AW_test',
      },
      status: JobStatus.RUNNING,
      start: vi.fn(async () => {}),
      initialize: vi.fn(async () => {}),
      launchJob: vi.fn(async () => {}),
      join: vi.fn(() => jobFinished.await),
      close: vi.fn(async () => {}),
    };
    const processes = vi
      .spyOn(ProcPool.prototype, 'processes', 'get')
      .mockReturnValue([activeProc]);
    const server = new AgentServer(
      new ServerOptions({
        agent: 'test-agent.js',
        wsURL: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        apiKey: 'devkey',
        apiSecret: 'devsecret',
        numIdleProcesses: 0,
        simulation: true,
      }),
    );

    const run = server.run().catch(() => undefined);
    let drain: Promise<void> | undefined;
    try {
      await registered.await;
      drain = server.drain().catch(() => undefined);
      const ticks = 3;
      const reported = new Promise<void>((resolve) => {
        onFullUpdate = () => fullUpdates > ticks && resolve();
      });
      await vi.advanceTimersByTimeAsync(ticks * 1500);
      await reported;
      expect(fullUpdates).toBeGreaterThan(ticks);
    } finally {
      jobFinished.resolve();
      await drain;
      await server.close();
      await run;
      processes.mockRestore();
      wss.close();
      vi.useRealTimers();
    }
  });
});

describe('AgentServer reconnect', () => {
  it('reports the jobs it runs, as assigned, after it registers', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, 'listening');
    const migrated = new Future<MigrateJobRequest>();
    wss.on('connection', (ws) => {
      ws.on('message', (data: Buffer) => {
        const msg = WorkerMessage.fromBinary(new Uint8Array(data));
        if (msg.message.case === 'register') {
          const res = new RegisterWorkerResponse({ workerId: 'AW_test' });
          ws.send(new ServerMessage({ message: { case: 'register', value: res } }).toBinary());
        } else if (msg.message.case === 'migrateJob') {
          migrated.resolve(msg.message.value);
        }
      });
    });

    // the job as the availability request carried it: the identity is the one
    // the worker accepted it with
    const job = new Job({ id: 'AJ_running', state: new JobState({ workerId: 'AW_test' }) });
    const activeProc: JobExecutor = {
      started: true,
      userArguments: {},
      runningJob: {
        job,
        acceptArguments: { name: 'test', identity: 'agent-identity', metadata: '' },
        url: 'ws://localhost',
        token: 'test-token',
        workerId: 'AW_test',
      },
      status: JobStatus.RUNNING,
      start: vi.fn(async () => {}),
      initialize: vi.fn(async () => {}),
      launchJob: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const processes = vi
      .spyOn(ProcPool.prototype, 'processes', 'get')
      .mockReturnValue([activeProc]);
    const server = new AgentServer(
      new ServerOptions({
        agent: 'test-agent.js',
        wsURL: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        apiKey: 'devkey',
        apiSecret: 'devsecret',
        numIdleProcesses: 0,
        simulation: true,
      }),
    );

    const run = server.run().catch(() => undefined);
    try {
      const req = await migrated.await;
      expect(req.jobIds).toEqual(['AJ_running']);
      expect(req.jobs).toHaveLength(1);
      expect(req.jobs[0]!.id).toBe('AJ_running');
      expect(req.jobs[0]!.state?.workerId).toBe('AW_test');
      expect(req.jobs[0]!.state?.participantIdentity).toBe('agent-identity');
      expect(job.state?.participantIdentity, 'the running job is not changed').toBe('');
    } finally {
      await server.close();
      await run;
      processes.mockRestore();
      wss.close();
    }
  });
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
