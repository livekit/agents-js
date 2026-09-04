// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, getJobContext } from './job.js';
import {
  finalizeSession,
  flushJobLogs,
  runShutdownCallbacks,
  waitForEntrypointShutdown,
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
    warn: vi.fn(),
  } as unknown as Logger;
}

function createJobContext(
  onSessionEnd: () => Promise<void>,
  session?: Pick<AgentSession, 'close'>,
): JobContext {
  return { _onSessionEnd: onSessionEnd, _primaryAgentSession: session } as unknown as JobContext;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('waitForEntrypointShutdown', () => {
  it('logs an entrypoint error during shutdown', async () => {
    const error = new TypeError('entrypoint failed');
    const logger = createLogger();

    await waitForEntrypointShutdown(Promise.reject(error), logger);

    expect(logger.error).toHaveBeenCalledWith({ error }, 'error in entry function');
  });

  it('continues after 15 seconds and safely handles a later rejection', async () => {
    vi.useFakeTimers();
    const error = new Error('late entrypoint failure');
    const logger = createLogger();
    let rejectEntrypoint!: (error: Error) => void;
    const entrypoint = new Promise<void>((_, reject) => {
      rejectEntrypoint = reject;
    });
    const completion = waitForEntrypointShutdown(entrypoint, logger);

    await vi.advanceTimersByTimeAsync(15_000);
    await completion;

    expect(logger.warn).toHaveBeenCalledWith(
      { timeout: 15_000 },
      'entrypoint did not exit in time; proceeding with session cleanup',
    );

    rejectEntrypoint(error);
    await vi.waitFor(() =>
      expect(logger.debug).toHaveBeenCalledWith(
        { error },
        'entrypoint rejected after shutdown timeout',
      ),
    );
  });
});

describe('finalizeSession', () => {
  it('closes the primary session before the application callback', async () => {
    const calls: string[] = [];
    const ctx = createJobContext(
      async () => {
        calls.push('internal');
      },
      {
        close: async () => {
          calls.push('close');
        },
      },
    );

    await finalizeSession(
      ctx,
      () => {
        calls.push('application');
      },
      1000,
      createLogger(),
    );

    expect(calls).toEqual(['close', 'application', 'internal']);
  });

  it('skips the application callback when the primary session fails to close', async () => {
    const error = new Error('close failed');
    const applicationCallback = vi.fn();
    const internalCleanup = vi.fn(async () => {});
    const logger = createLogger();
    const ctx = createJobContext(internalCleanup, {
      close: async () => {
        throw error;
      },
    });

    await finalizeSession(ctx, applicationCallback, 1000, logger);

    expect(applicationCallback).not.toHaveBeenCalled();
    expect(internalCleanup).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { error },
      'AgentSession.close() failed; proceeding with shutdown without running onSessionEnd.',
    );
  });

  it('skips the application callback when the primary session close times out', async () => {
    vi.useFakeTimers();
    const applicationCallback = vi.fn();
    const internalCleanup = vi.fn(async () => {});
    const logger = createLogger();
    const ctx = createJobContext(internalCleanup, {
      close: () => new Promise<void>(() => {}),
    });
    const completion = finalizeSession(ctx, applicationCallback, 1000, logger);

    await vi.advanceTimersByTimeAsync(60_000);
    await completion;

    expect(applicationCallback).not.toHaveBeenCalled();
    expect(internalCleanup).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { timeout: 60_000 },
      'AgentSession.close() timed out; proceeding with shutdown without running onSessionEnd.',
    );
  });

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

  it('keeps the job context active through application and internal cleanup', async () => {
    const ctx: JobContext = createJobContext(async () => {
      expect(getJobContext()).toBe(ctx);
    });

    await finalizeSession(
      ctx,
      () => {
        expect(getJobContext()).toBe(ctx);
      },
      1000,
      createLogger(),
    );
  });

  it('continues internal cleanup when the application callback rejects', async () => {
    const error = new TypeError('callback failed');
    const internalCleanup = vi.fn(async () => {});
    const logger = createLogger();

    await finalizeSession(
      createJobContext(internalCleanup),
      async () => {
        throw error;
      },
      1000,
      logger,
    );

    expect(internalCleanup).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { error },
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

  it('logs a callback error that arrives after its timeout', async () => {
    vi.useFakeTimers();
    const error = new Error('late callback failure');
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
    rejectCallback(error);

    await vi.waitFor(() =>
      expect(logger.debug).toHaveBeenCalledWith(
        { error },
        'onSessionEnd rejected after shutdown timeout',
      ),
    );
  });

  it('logs internal cleanup errors', async () => {
    const error = new Error('session report failed');
    const logger = createLogger();

    await finalizeSession(
      createJobContext(async () => {
        throw error;
      }),
      undefined,
      1000,
      logger,
    );

    expect(logger.error).toHaveBeenCalledWith({ error }, 'error in ctx._onSessionEnd');
  });

  it('does not apply the application callback timeout to internal cleanup', async () => {
    vi.useFakeTimers();
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    let completed = false;
    const completion = finalizeSession(
      createJobContext(() => cleanup),
      undefined,
      1000,
      createLogger(),
    );
    void completion.then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(900_000);
    expect(completed).toBe(false);

    resolveCleanup();
    await completion;
    expect(completed).toBe(true);
  });
});

describe('runShutdownCallbacks', () => {
  it('logs callback errors', async () => {
    const error = new TypeError('shutdown callback failed');
    const logger = createLogger();

    await runShutdownCallbacks(
      [
        async () => {
          throw error;
        },
      ],
      logger,
    );

    expect(logger.error).toHaveBeenCalledWith({ error }, 'error while running shutdown callback');
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

  it('continues after logging log exporter errors', async () => {
    const error = new Error('exporter failed');
    const logger = createLogger();
    flushOtelLogsMock.mockRejectedValue(error);

    await flushJobLogs(logger);

    expect(logger.error).toHaveBeenCalledWith({ error }, 'Failed to flush OTEL logs');
  });
});
