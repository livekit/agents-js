// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job } from '@livekit/protocol';
import { DisconnectReason } from '@livekit/rtc-node';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobToken } from '../job_token.js';
import { initializeLogger } from '../log.js';
import { JobStatus } from './job_executor.js';
import { JobProcExecutor } from './job_proc_executor.js';
import type { IPCMessage } from './message.js';

initializeLogger({ pretty: false, level: 'silent' });

// Exercise the actual child entrypoint and exit code, without depending on a prior build.
class TestJobProcExecutor extends JobProcExecutor {
  scenario?: string;

  createProcess() {
    return fork(
      new URL('./job_proc_lazy_main.ts', import.meta.url),
      [
        fileURLToPath(new URL('./job_proc_lazy_main_test_agent.ts', import.meta.url)),
        this.scenario ?? '',
      ],
      {
        execArgv: [
          // The build and Vitest normally supply this compile-time constant.
          '--import',
          'data:text/javascript,globalThis.__PACKAGE_VERSION__="0.0.0-test"',
          '--import',
          import.meta.resolve('tsx'),
        ],
        env: {
          ...process.env,
          LIVEKIT_AGENTS_PRELOAD_LOCAL_INFERENCE: '0',
        },
      },
    );
  }
}

describe('job entrypoint failures', () => {
  it.each([
    ['raise before connect', JobStatus.FAILED, 1],
    ['raise after connect', JobStatus.FAILED, 1],
    ['connect rejects', JobStatus.FAILED, 1],
    ['synchronous throw', JobStatus.FAILED, 1],
    ['shutdown then raise', JobStatus.SUCCESS, 0],
    ['normal shutdown', JobStatus.SUCCESS, 0],
  ])(
    'reports %s after cleanup',
    async (scenario, status, exitCode) => {
      const proc = new TestJobProcExecutor({
        agent: 'unused',
        initializeTimeout: 10_000,
        closeTimeout: 1000,
        memoryWarnMB: 0,
        memoryLimitMB: 0,
        pingInterval: 2500,
        pingTimeout: 60_000,
        highPingThreshold: 500,
      });
      const messages: string[] = [];
      let disconnectReason: DisconnectReason | undefined;

      try {
        await proc.start();
        proc.proc!.on('message', (message: { case: string; reason?: DisconnectReason }) => {
          messages.push(message.case);
          if (message.case === 'testDisconnect') disconnectReason = message.reason;
        });
        await proc.initialize({ sessionEndTimeout: 1000 });
        await proc.launchJob({
          acceptArguments: { name: 'n', identity: 'i', metadata: '' },
          job: new Job({ id: 'AJ_1', metadata: scenario }),
          url: 'wss://example.com',
          token: 'token',
          workerId: 'W_1',
          fakeJob: scenario !== 'connect rejects',
        });
        await proc.join();

        expect(proc.status).toBe(status);
        expect(proc.proc!.exitCode).toBe(exitCode);
        expect(proc.proc!.signalCode).toBeNull();
        expect(proc.proc!.killed).toBe(false);
        expect(disconnectReason).toBe(
          status === JobStatus.FAILED
            ? DisconnectReason.AGENT_ERROR
            : DisconnectReason.CLIENT_INITIATED,
        );
        expect(messages).toEqual([
          'initializeResponse',
          'exiting',
          'testSessionEnd',
          'shuttingDown',
          'testDisconnect',
          'testShutdownCallback',
          'done',
        ]);
      } finally {
        await proc.close();
      }
    },
    20_000,
  );

  it.each([
    ['telemetry setup rejects', JobStatus.FAILED, 1],
    ['root span creation throws', JobStatus.FAILED, 1],
    ['job startup throws', JobStatus.FAILED, 1],
    ['setup rejects after shutdown', JobStatus.SUCCESS, 0],
  ])(
    'ends %s without starting the entrypoint',
    async (scenario, status, exitCode) => {
      const proc = new TestJobProcExecutor({
        agent: 'unused',
        initializeTimeout: 10_000,
        closeTimeout: 1000,
        memoryWarnMB: 0,
        memoryLimitMB: 0,
        pingInterval: 10_000,
        pingTimeout: 3000,
        highPingThreshold: 500,
      });
      proc.scenario = scenario;
      const messages: string[] = [];

      try {
        await proc.start();
        proc.proc!.on('message', (message: { case: string }) => messages.push(message.case));
        await proc.initialize({ sessionEndTimeout: 1000 });
        await proc.launchJob({
          acceptArguments: { name: 'n', identity: 'i', metadata: '' },
          job: new Job({ id: 'AJ_setup_failure' }),
          url: 'wss://example.com',
          token: 'token',
          workerId: 'W_1',
          fakeJob: true,
        });
        await proc.join();

        expect(proc.status).toBe(status);
        expect(proc.proc!.exitCode).toBe(exitCode);
        expect(proc.proc!.signalCode).toBeNull();
        expect(proc.proc!.killed).toBe(false);
        expect(messages).not.toContain('testEntrypoint');
        if (scenario !== 'job startup throws') {
          expect(messages.filter((message) => message === 'testCleanup')).toHaveLength(1);
          expect(messages.at(-1)).toBe('done');
        }
      } finally {
        await proc.close();
      }
    },
    15_000,
  );
});

describe('job API tokens', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  /** Runs the 'job api' scenario: the job deletes its room twice, through the server API. */
  const runJobApi = async (opts: {
    createJobToken: (jobId: string, claims: string) => Promise<JobToken>;
    apiKey?: string;
    apiSecret?: string;
  }) => {
    const proc = new TestJobProcExecutor({
      agent: 'unused',
      initializeTimeout: 10_000,
      closeTimeout: 1000,
      memoryWarnMB: 0,
      memoryLimitMB: 0,
      pingInterval: 2500,
      pingTimeout: 60_000,
      highPingThreshold: 500,
      createJobToken: opts.createJobToken,
    });
    const authorizations: (string | null)[] = [];
    const tokenResponses: IPCMessage[] = [];
    try {
      await proc.start();
      proc.proc!.on('message', (message: { case: string; authorization?: string | null }) => {
        if (message.case === 'testFetch') authorizations.push(message.authorization ?? null);
      });
      const send = proc.proc!.send.bind(proc.proc!);
      proc.proc!.send = ((message: IPCMessage, ...args: never[]) => {
        if (message.case === 'createJobTokenResponse') tokenResponses.push(message);
        return send(message, ...args);
      }) as typeof proc.proc.send;
      await proc.initialize({ sessionEndTimeout: 1000 });
      await proc.launchJob({
        acceptArguments: { name: 'n', identity: 'i', metadata: '' },
        job: new Job({ id: 'AJ_api', metadata: 'job api' }),
        url: 'wss://example.com',
        token: 'token',
        workerId: 'W_1',
        apiKey: opts.apiKey,
        apiSecret: opts.apiSecret,
      });
      await proc.join();
      expect(proc.status).toBe(JobStatus.SUCCESS);
    } finally {
      await proc.close();
    }
    return { authorizations, tokenResponses };
  };

  const tokenModeEnv = () => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    process.env.LIVEKIT_TOKEN = 'worker-token';
  };

  it('in token mode, asks the worker for each call token, and caches it', async () => {
    tokenModeEnv();
    const createJobToken = vi.fn(async (_jobId: string, _claims: string) => ({
      token: 'job-token',
      expiresAt: Date.now() + 600_000,
    }));

    const { authorizations } = await runJobApi({ createJobToken });

    expect(authorizations).toEqual(['Bearer job-token', 'Bearer job-token']);
    expect(createJobToken).toHaveBeenCalledTimes(1);
    const [jobId, claims] = createJobToken.mock.calls[0]!;
    expect(jobId).toBe('AJ_api');
    expect(JSON.parse(claims)).toEqual({ video: { roomCreate: true } });
  }, 20_000);

  it('in token mode, carries the server error back to the job', async () => {
    tokenModeEnv();
    const createJobToken = vi.fn(async () => {
      throw new Error('the LiveKit server refused CreateJobToken: claim not allowed');
    });

    const { authorizations, tokenResponses } = await runJobApi({ createJobToken });

    // each call asks again: a refusal is not cached
    expect(createJobToken).toHaveBeenCalledTimes(2);
    expect(authorizations).toEqual([]);
    expect(tokenResponses.map((m) => m.value)).toEqual([
      expect.objectContaining({
        error: 'the LiveKit server refused CreateJobToken: claim not allowed',
      }),
      expect.objectContaining({
        error: 'the LiveKit server refused CreateJobToken: claim not allowed',
      }),
    ]);
  }, 20_000);

  it('with an API key and secret, signs each call token itself', async () => {
    process.env.LIVEKIT_TOKEN = 'worker-token';
    const createJobToken = vi.fn();

    const { authorizations } = await runJobApi({
      createJobToken,
      apiKey: 'devkey',
      apiSecret: 'secretsecretsecretsecretsecretsecret',
    });

    expect(createJobToken).not.toHaveBeenCalled();
    expect(authorizations).toHaveLength(2);
    const claims = JSON.parse(
      Buffer.from(authorizations[0]!.split('.')[1]!, 'base64url').toString(),
    );
    expect(claims).toMatchObject({ iss: 'devkey', video: { roomCreate: true } });
  }, 20_000);

  it('in token mode, the job reads the current worker token: at start, and after a refresh', async () => {
    tokenModeEnv(); // the process starts with 'worker-token'
    const proc = new TestJobProcExecutor({
      agent: 'unused',
      initializeTimeout: 10_000,
      closeTimeout: 1000,
      memoryWarnMB: 0,
      memoryLimitMB: 0,
      pingInterval: 2500,
      pingTimeout: 60_000,
      highPingThreshold: 500,
    });
    const tokens: (string | undefined)[] = [];
    try {
      await proc.start();
      proc.proc!.on('message', (message: { case: string; token?: string }) => {
        if (message.case === 'testWorkerToken') tokens.push(message.token);
      });
      await proc.initialize({ sessionEndTimeout: 1000 });

      // refreshed in the worker while the process was idle
      process.env.LIVEKIT_TOKEN = 'refreshed-before-start';
      await proc.launchJob({
        acceptArguments: { name: 'n', identity: 'i', metadata: '' },
        job: new Job({ id: 'AJ_token', metadata: 'worker token' }),
        url: 'wss://example.com',
        token: 'token',
        workerId: 'W_1',
      });
      await vi.waitFor(() => expect(tokens).toEqual(['refreshed-before-start']));

      // refreshed while the job runs
      proc.updateWorkerToken('refreshed-while-running');
      proc.proc!.send({ case: 'testReportWorkerToken' } as unknown as IPCMessage);
      await vi.waitFor(() =>
        expect(tokens).toEqual(['refreshed-before-start', 'refreshed-while-running']),
      );

      proc.proc!.send({ case: 'testEnd' } as unknown as IPCMessage);
      await proc.join();
      expect(proc.status).toBe(JobStatus.SUCCESS);
    } finally {
      await proc.close();
    }
  }, 20_000);
});
