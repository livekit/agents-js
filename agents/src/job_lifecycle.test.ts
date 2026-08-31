// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from './job.js';
import { closeAgentSession, finalizeSession, flushJobLogs } from './job_lifecycle.js';
import { flushOtelLogs } from './telemetry/index.js';
import type { AgentSession } from './voice/agent_session.js';

vi.mock('./telemetry/index.js', () => ({
  flushOtelLogs: vi.fn(),
}));

const flushOtelLogsMock = vi.mocked(flushOtelLogs);

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function createJobContext(onSessionEnd: () => Promise<void>): JobContext {
  return { _onSessionEnd: onSessionEnd } as unknown as JobContext;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('finalizeSession', () => {
  it('runs the application callback before internal session cleanup', async () => {
    const calls: string[] = [];
    const ctx = createJobContext(async () => {
      calls.push('internal');
    });

    await finalizeSession(
      ctx,
      () => {
        calls.push('application');
      },
      1000,
      createLogger(),
    );

    expect(calls).toEqual(['application', 'internal']);
  });

  it('continues internal cleanup when the application callback rejects', async () => {
    const internalCleanup = vi.fn(async () => {});
    const logger = createLogger();

    await finalizeSession(
      createJobContext(internalCleanup),
      async () => {
        throw new Error('callback failed');
      },
      1000,
      logger,
    );

    expect(internalCleanup).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { error: expect.objectContaining({ message: 'callback failed' }) },
      'error while executing the onSessionEnd callback',
    );
  });

  it('continues internal cleanup when the application callback times out', async () => {
    vi.useFakeTimers();
    const internalCleanup = vi.fn(async () => {});
    const logger = createLogger();
    const completion = finalizeSession(
      createJobContext(internalCleanup),
      () => new Promise<void>(() => {}),
      1000,
      logger,
    );

    await vi.advanceTimersByTimeAsync(1000);
    await completion;

    expect(internalCleanup).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { timeout: 1000 },
      'onSessionEnd timed out; proceeding with internal session cleanup',
    );
  });
});

describe('closeAgentSession', () => {
  it('stops waiting after the session close timeout', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const session: Pick<AgentSession, 'close'> = {
      close: () => new Promise<void>(() => {}),
    };
    const completion = closeAgentSession(session, logger);

    await vi.advanceTimersByTimeAsync(60_000);
    await completion;

    expect(logger.error).toHaveBeenCalledWith(
      { timeout: 60_000 },
      'AgentSession.close() timed out; proceeding with shutdown so registered callbacks still run.',
    );
  });
});

describe('flushJobLogs', () => {
  it('flushes pending OTEL logs', async () => {
    flushOtelLogsMock.mockResolvedValue();
    await flushJobLogs(createLogger());
    expect(flushOtelLogsMock).toHaveBeenCalledOnce();
  });

  it('stops waiting after the log flush timeout', async () => {
    vi.useFakeTimers();
    flushOtelLogsMock.mockReturnValue(new Promise<void>(() => {}));
    const logger = createLogger();
    const completion = flushJobLogs(logger);

    await vi.advanceTimersByTimeAsync(10_000);
    await completion;

    expect(logger.error).toHaveBeenCalledWith(
      { timeout: 10_000 },
      'OTEL log flush timed out; proceeding with job shutdown',
    );
  });
});
