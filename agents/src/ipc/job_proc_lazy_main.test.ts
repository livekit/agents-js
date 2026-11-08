// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job } from '@livekit/protocol';
import { Room } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { JobProcess, type RunningJobInfo } from '../job.js';
import { initializeLogger, log } from '../log.js';
import { Future } from '../utils.js';
import { startJob } from './job_proc_lazy_main.js';

initializeLogger({ pretty: false, level: 'silent' });

const jobInfo = {
  acceptArguments: { name: 'n', identity: 'i', metadata: '' },
  job: new Job({ id: 'AJ_1' }),
  url: 'wss://example.com',
  token: 'token',
  workerId: 'W_1',
  fakeJob: true,
} as RunningJobInfo;

describe('job entrypoint failures', () => {
  it.each([
    ['raise before connect', true, false],
    ['raise after connect', true, true],
    ['shutdown then raise', false, true],
    ['normal shutdown', false, true],
  ])('reports %s correctly', async (scenario, expectedFailure, connect) => {
    const disconnect = vi.spyOn(Room.prototype, 'disconnect').mockResolvedValue();
    let shutdownCallbacks = 0;
    const closeEvent = new EventEmitter();
    const join = new Future();
    const job = startJob(
      new JobProcess(),
      async (ctx) => {
        ctx.addShutdownCallback(async () => {
          shutdownCallbacks++;
        });
        if (scenario === 'raise before connect')
          throw new Error('entrypoint failed before connect');
        if (connect) await ctx.connect();
        if (scenario === 'raise after connect') throw new Error('entrypoint failed after connect');
        ctx.shutdown();
        if (scenario === 'shutdown then raise') throw new Error('entrypoint failed after shutdown');
      },
      jobInfo,
      closeEvent,
      log(),
      join,
      1000,
    );

    try {
      await job.task;

      expect(job.failed).toBe(expectedFailure);
      expect(shutdownCallbacks).toBe(1);
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      disconnect.mockRestore();
    }
  });
});
