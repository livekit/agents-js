// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobProcExecutor } from './job_proc_executor.js';

vi.mock('node:child_process', () => ({
  fork: vi.fn(),
}));

const forkMock = vi.mocked(fork);

beforeEach(() => {
  forkMock.mockReset();
  forkMock.mockReturnValue({} as ChildProcess);
});

describe('JobProcExecutor', () => {
  it('passes the session end timeout to the job process', () => {
    const executor = new JobProcExecutor(
      'agent.ts',
      undefined,
      1000,
      2000,
      12_345,
      0,
      0,
      2500,
      60000,
      500,
    );

    executor.createProcess();

    expect(forkMock.mock.calls[0]?.[1]).toEqual(['agent.ts', '12345']);
  });
});
