// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from './job.js';
import {
  closeAgentSession,
  finalizeSession,
  flushJobLogs,
  getSessionEndShutdownTimeout,
  runShutdownCallbacks,
} from './job_lifecycle.js';
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

describe('getSessionEndShutdownTimeout', () => {
  it('covers every bounded child lifecycle phase', () => {
    expect(getSessionEndShutdownTimeout(1000, 2000)).toBe(974_000);
  });
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
    const secret = 'secret callback payload';
    const internalCleanup = vi.fn(async () => {});
    const logger = createLogger();

    await finalizeSession(
      createJobContext(internalCleanup),
      async () => {
        throw new TypeError(secret);
      },
      1000,
      logger,
    );

    expect(internalCleanup).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { exceptionType: 'TypeError' },
      'error while executing the onSessionEnd callback',
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(secret);
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

  it('does not expose a callback error that arrives after its timeout', async () => {
    vi.useFakeTimers();
    const secret = 'secret late callback payload';
    const logger = createLogger();
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<void>((_, reject) => {
      rejectCallback = reject;
    });
    const completion = finalizeSession(
      createJobContext(async () => {}),
      () => callback,
      1000,
      logger,
    );

    await vi.advanceTimersByTimeAsync(1000);
    await completion;
    rejectCallback(new Error(secret));

    await vi.waitFor(() =>
      expect(logger.debug).toHaveBeenCalledWith(
        { exceptionType: 'Error' },
        'onSessionEnd rejected after shutdown timeout',
      ),
    );
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(secret);
  });

  it('does not expose internal cleanup errors', async () => {
    const secret = 'secret session report payload';
    const logger = createLogger();

    await finalizeSession(
      createJobContext(async () => {
        throw new Error(secret);
      }),
      undefined,
      1000,
      logger,
    );

    expect(logger.error).toHaveBeenCalledWith(
      { exceptionType: 'Error' },
      'error in ctx._onSessionEnd',
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(secret);
  });

  it('stops waiting after the internal session cleanup timeout', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const completion = finalizeSession(
      createJobContext(() => new Promise<void>(() => {})),
      undefined,
      1000,
      logger,
    );

    await vi.advanceTimersByTimeAsync(900_000);
    await completion;

    expect(logger.error).toHaveBeenCalledWith(
      { timeout: 900_000 },
      'internal session cleanup timed out; proceeding with job shutdown',
    );
  });

  it('does not expose an internal cleanup error that arrives after its timeout', async () => {
    vi.useFakeTimers();
    const secret = 'secret late session report payload';
    const logger = createLogger();
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<void>((_, reject) => {
      rejectCleanup = reject;
    });
    const completion = finalizeSession(
      createJobContext(() => cleanup),
      undefined,
      1000,
      logger,
    );

    await vi.advanceTimersByTimeAsync(900_000);
    await completion;
    rejectCleanup(new Error(secret));

    await vi.waitFor(() =>
      expect(logger.debug).toHaveBeenCalledWith(
        { exceptionType: 'Error' },
        'ctx._onSessionEnd rejected after shutdown timeout',
      ),
    );
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(secret);
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

  it('continues without exposing an immediate close error', async () => {
    const secret = 'secret close payload';
    const logger = createLogger();
    const session: Pick<AgentSession, 'close'> = {
      close: async () => {
        throw new Error(secret);
      },
    };

    await closeAgentSession(session, logger);

    expect(logger.error).toHaveBeenCalledWith(
      { exceptionType: 'Error' },
      'AgentSession.close() failed; proceeding with shutdown so registered callbacks still run.',
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(secret);
  });
});

describe('runShutdownCallbacks', () => {
  it('does not expose callback errors', async () => {
    const secret = 'secret shutdown callback payload';
    const logger = createLogger();

    await runShutdownCallbacks(
      [
        async () => {
          throw new TypeError(secret);
        },
      ],
      1000,
      logger,
    );

    expect(logger.error).toHaveBeenCalledWith(
      { exceptionType: 'TypeError' },
      'error while running shutdown callback',
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(secret);
  });

  it('stops waiting after the shutdown callback timeout', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const callback = vi.fn(() => new Promise<void>(() => {}));
    const completion = runShutdownCallbacks([callback], 1000, logger);

    await vi.advanceTimersByTimeAsync(1000);
    await completion;

    expect(callback).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { timeout: 1000 },
      'shutdown callbacks timed out; proceeding with job shutdown',
    );
  });

  it('does not expose a callback error that arrives after its timeout', async () => {
    vi.useFakeTimers();
    const secret = 'secret late shutdown callback payload';
    const logger = createLogger();
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<void>((_, reject) => {
      rejectCallback = reject;
    });
    const completion = runShutdownCallbacks([() => callback], 1000, logger);

    await vi.advanceTimersByTimeAsync(1000);
    await completion;
    rejectCallback(new RangeError(secret));

    await vi.waitFor(() =>
      expect(logger.debug).toHaveBeenCalledWith(
        { exceptionType: 'RangeError' },
        'shutdown callback rejected after shutdown timeout',
      ),
    );
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(secret);
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

  it('does not expose log exporter errors', async () => {
    const secret = 'secret exporter response';
    const logger = createLogger();
    flushOtelLogsMock.mockRejectedValue(new Error(secret));

    await flushJobLogs(logger);

    expect(logger.error).toHaveBeenCalledWith(
      { exceptionType: 'Error' },
      'Failed to flush OTEL logs',
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(secret);
  });
});
