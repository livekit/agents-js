// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type CreateJobTokenRequest,
  CreateJobTokenResponse,
  Job,
  JobJoinTiming,
  JobState,
  type MigrateJobRequest,
  JobStatus as ProtoJobStatus,
  RegisterWorkerResponse,
  ServerInfo,
  ServerMessage,
  type UpdateJobStatus,
  WorkerMessage,
  WorkerStatus,
} from '@livekit/protocol';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { type JobExecutor, JobStatus } from './ipc/job_executor.js';
import { JobProcExecutor } from './ipc/job_proc_executor.js';
import { ProcPool } from './ipc/proc_pool.js';
import { Future } from './utils.js';
import { AgentServer, MissingCredentialsError, ServerOptions } from './worker.js';

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

    // the worker sends status only once it has the register response
    const workerRegistered = once(server.event, 'worker_registered');
    const run = server.run().catch(() => undefined);
    let drain: Promise<void> | undefined;
    try {
      await registered.await;
      await workerRegistered;
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

describe('AgentServer job status', () => {
  const runningProc = (): JobExecutor => ({
    started: true,
    userArguments: {},
    runningJob: {
      job: new Job({ id: 'AJ_running' }),
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
  });

  const newServer = (wss: WebSocketServer) =>
    new AgentServer(
      new ServerOptions({
        agent: 'test-agent.js',
        wsURL: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        apiKey: 'devkey',
        apiSecret: 'devsecret',
        numIdleProcesses: 0,
        simulation: true,
      }),
    );

  it.each([
    [JobStatus.FAILED, ProtoJobStatus.JS_FAILED],
    [JobStatus.SUCCESS, ProtoJobStatus.JS_SUCCESS],
  ])('reports a job launched, connected, and ended as %s', async (finalStatus, protoStatus) => {
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, 'listening');
    const registered = new Future();
    const updates: UpdateJobStatus[] = [];
    const allUpdates = new Future();
    wss.on('connection', (ws) => {
      ws.on('message', (data: Buffer) => {
        const msg = WorkerMessage.fromBinary(new Uint8Array(data));
        if (msg.message.case === 'register') {
          const res = new RegisterWorkerResponse({ workerId: 'AW_test' });
          ws.send(new ServerMessage({ message: { case: 'register', value: res } }).toBinary());
          registered.resolve();
        } else if (msg.message.case === 'updateJob') {
          updates.push(msg.message.value);
          if (updates.length === 3) allUpdates.resolve();
        }
      });
    });

    // the pool calls back on launch, on connect and on the end of the job
    const start = vi.spyOn(ProcPool.prototype, 'start').mockImplementation(() => {});
    const proc = runningProc();
    const server = newServer(wss);

    const run = server.run().catch(() => undefined);
    try {
      await registered.await;
      const pool = start.mock.contexts[0] as ProcPool;
      const timing = new JobJoinTiming({ acceptedUs: 7n, connectedUs: 9n });
      pool.onJobUpdate!(proc);
      pool.onJobUpdate!(proc, timing);
      proc.status = finalStatus;
      pool.onJobUpdate!(proc);
      await allUpdates.await;

      expect(updates.map((u) => u.jobId)).toEqual(['AJ_running', 'AJ_running', 'AJ_running']);
      expect(updates.map((u) => u.status)).toEqual([
        ProtoJobStatus.JS_RUNNING,
        ProtoJobStatus.JS_RUNNING,
        protoStatus,
      ]);
      expect(updates.map((u) => u.joinTiming)).toEqual([undefined, timing, undefined]);
    } finally {
      await server.close();
      await run;
      start.mockRestore();
      wss.close();
    }
  });

  it('holds a job update until the connection registers, and drops load updates', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, 'listening');
    const seen: string[] = [];
    const respond = new Future<() => void>();
    const updated = new Future();
    wss.on('connection', (ws) => {
      ws.on('message', (data: Buffer) => {
        const msg = WorkerMessage.fromBinary(new Uint8Array(data));
        seen.push(msg.message.case!);
        if (msg.message.case === 'register') {
          const res = new RegisterWorkerResponse({ workerId: 'AW_test' });
          respond.resolve(() => {
            seen.push('registered');
            ws.send(new ServerMessage({ message: { case: 'register', value: res } }).toBinary());
          });
        } else if (msg.message.case === 'updateJob') {
          updated.resolve();
        }
      });
    });

    const start = vi.spyOn(ProcPool.prototype, 'start').mockImplementation(() => {});
    const server = newServer(wss);

    const run = server.run().catch(() => undefined);
    try {
      const sendRegistered = await respond.await;
      const pool = start.mock.contexts[0] as ProcPool;
      pool.onJobUpdate!(runningProc());
      server.event.emit(
        'worker_msg',
        new WorkerMessage({ message: { case: 'updateWorker', value: { load: 0.5 } } }),
      );
      // a message sent at once would reach the server in this time
      await delay(50);
      sendRegistered();
      await updated.await;

      expect(seen).toEqual(['register', 'registered', 'updateJob']);
    } finally {
      await server.close();
      await run;
      start.mockRestore();
      wss.close();
    }
  });
});

describe('AgentServer token mode', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  /**
   * A fake server of this agent protocol: registers the worker and answers its job token requests
   * with `answer`.
   */
  const fakeServer = async (
    answer?: (req: CreateJobTokenRequest) => CreateJobTokenResponse,
    agentProtocol = 2,
  ) => {
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, 'listening');
    const authorization = new Future<string | undefined>();
    const registered = new Future();
    const tokenRequests: CreateJobTokenRequest[] = [];
    let connections = 0;
    wss.on('connection', (ws, req) => {
      connections++;
      authorization.resolve(req.headers.authorization);
      ws.on('message', (data: Buffer) => {
        const msg = WorkerMessage.fromBinary(new Uint8Array(data));
        if (msg.message.case === 'register') {
          const res = new RegisterWorkerResponse({
            workerId: 'AW_test',
            serverInfo: new ServerInfo({ agentProtocol }),
          });
          ws.send(new ServerMessage({ message: { case: 'register', value: res } }).toBinary());
          registered.resolve();
        } else if (msg.message.case === 'createJobToken') {
          tokenRequests.push(msg.message.value);
          if (answer) {
            const res = answer(msg.message.value);
            ws.send(
              new ServerMessage({ message: { case: 'createJobToken', value: res } }).toBinary(),
            );
          }
        }
      });
    });
    return { wss, authorization, registered, tokenRequests, connections: () => connections };
  };

  const newServer = (wss: WebSocketServer, opts: { apiKey?: string; apiSecret?: string } = {}) =>
    new AgentServer(
      new ServerOptions({
        agent: 'test-agent.js',
        wsURL: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        numIdleProcesses: 0,
        simulation: true,
        ...opts,
      }),
    );

  const tokenModeEnv = () => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    process.env.LIVEKIT_TOKEN = 'worker-token';
  };

  it('registers with LIVEKIT_TOKEN as the bearer, and routes job tokens by request id', async () => {
    tokenModeEnv();
    const { wss, authorization, registered, tokenRequests } = await fakeServer(
      (req) =>
        new CreateJobTokenResponse({
          requestId: req.requestId,
          token: `job-token-for-${req.jobId}`,
          expiresAt: 1_700_000_600n,
        }),
    );
    const start = vi.spyOn(ProcPool.prototype, 'start').mockImplementation(() => {});
    const server = newServer(wss);

    const workerRegistered = once(server.event, 'worker_registered');
    const run = server.run().catch(() => undefined);
    try {
      expect(await authorization.await).toBe('Bearer worker-token');
      await registered.await;
      await workerRegistered;

      const pool = start.mock.contexts[0] as ProcPool;
      await expect(pool.createJobToken!('AJ_1', '{"identity":"a"}')).resolves.toEqual({
        token: 'job-token-for-AJ_1',
        expiresAt: 1_700_000_600_000,
      });
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]!.jobId).toBe('AJ_1');
      expect(tokenRequests[0]!.claims).toBe('{"identity":"a"}');
      await expect(server.simulateJob('room')).rejects.toThrow(
        'simulateJob needs an API key and secret',
      );
    } finally {
      await server.close();
      await run;
      start.mockRestore();
      wss.close();
    }
  });

  it('fails up front, without retrying, on a server without token mode', async () => {
    tokenModeEnv();
    const { wss, registered, tokenRequests, connections } = await fakeServer(undefined, 1);
    const start = vi.spyOn(ProcPool.prototype, 'start').mockImplementation(() => {});
    const server = newServer(wss);
    const registeredEvent = vi.fn();
    server.event.on('worker_registered', registeredEvent);

    const run = server.run();
    run.catch(() => undefined); // asserted below
    try {
      await registered.await;
      // a job token asked for now has no connection to go out on
      const pool = start.mock.contexts[0] as ProcPool;
      await expect(pool.createJobToken!('AJ_1', '{}')).rejects.toThrow(
        'the worker is not connected to the LiveKit server',
      );
      await expect(run).rejects.toThrow(
        'the LiveKit server does not support token mode (LIVEKIT_TOKEN): it reports agent ' +
          'protocol 1, and token mode needs 2. Upgrade the server, or run the agent with ' +
          'LIVEKIT_API_KEY and LIVEKIT_API_SECRET',
      );
      expect(connections(), 'no reconnect').toBe(1);
      expect(tokenRequests).toEqual([]);
      expect(registeredEvent).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await run.catch(() => undefined);
      start.mockRestore();
      wss.close();
    }
  });

  it('runs in key mode on a server of agent protocol 1', async () => {
    const { wss, registered } = await fakeServer(undefined, 1);
    const server = newServer(wss, { apiKey: 'devkey', apiSecret: 'devsecret' });
    const registeredEvent = new Future();
    server.event.once('worker_registered', () => registeredEvent.resolve());

    const run = server.run().catch(() => undefined);
    try {
      await registered.await;
      await registeredEvent.await;
      expect(server.id).toBe('AW_test');
    } finally {
      await server.close();
      await run;
      wss.close();
    }
  });

  it('surfaces the server error of a refused job token', async () => {
    tokenModeEnv();
    const { wss, registered } = await fakeServer(
      (req) =>
        new CreateJobTokenResponse({
          requestId: req.requestId,
          error: 'claim not allowed: video.agent',
        }),
    );
    const start = vi.spyOn(ProcPool.prototype, 'start').mockImplementation(() => {});
    const server = newServer(wss);

    const workerRegistered = once(server.event, 'worker_registered');
    const run = server.run().catch(() => undefined);
    try {
      await registered.await;
      await workerRegistered;
      const pool = start.mock.contexts[0] as ProcPool;
      await expect(pool.createJobToken!('AJ_1', '{"video":{"agent":true}}')).rejects.toThrow(
        'the LiveKit server refused CreateJobToken: claim not allowed: video.agent',
      );
    } finally {
      await server.close();
      await run;
      start.mockRestore();
      wss.close();
    }
  });

  it('signs its own token when an API key and secret are set, even with LIVEKIT_TOKEN', async () => {
    process.env.LIVEKIT_TOKEN = 'worker-token';
    const { wss, authorization } = await fakeServer();
    const server = newServer(wss, { apiKey: 'devkey', apiSecret: 'devsecret' });

    const run = server.run().catch(() => undefined);
    try {
      const bearer = (await authorization.await)!.replace('Bearer ', '');
      const claims = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString());
      expect(claims).toMatchObject({ iss: 'devkey', video: { agent: true } });
      expect(process.env.LIVEKIT_TOKEN, 'not exported in key mode').toBe('worker-token');
    } finally {
      await server.close();
      await run;
      wss.close();
    }
  });

  it('reads an explicit token option, and exports it for the job processes', () => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_TOKEN;
    new AgentServer(
      new ServerOptions({ agent: 'test-agent.js', wsURL: 'ws://localhost', token: 'explicit' }),
    );
    expect(process.env.LIVEKIT_TOKEN).toBe('explicit');
  });

  it('keeps the key mode errors without a token', () => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_TOKEN;
    expect(
      () => new AgentServer(new ServerOptions({ agent: 'test-agent.js', wsURL: 'ws://localhost' })),
    ).toThrow(MissingCredentialsError);
    expect(
      () =>
        new AgentServer(
          new ServerOptions({ agent: 'test-agent.js', wsURL: 'ws://localhost', apiKey: 'devkey' }),
        ),
    ).toThrow('API Secret is required');
    // a key without a secret is key mode, even with a token
    process.env.LIVEKIT_TOKEN = 'worker-token';
    expect(
      () =>
        new AgentServer(
          new ServerOptions({ agent: 'test-agent.js', wsURL: 'ws://localhost', apiKey: 'devkey' }),
        ),
    ).toThrow('API Secret is required');
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
