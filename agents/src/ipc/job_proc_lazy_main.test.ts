// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job } from '@livekit/protocol';
import { DisconnectReason } from '@livekit/rtc-node';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { JobStatus } from './job_executor.js';
import { JobProcExecutor } from './job_proc_executor.js';

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
