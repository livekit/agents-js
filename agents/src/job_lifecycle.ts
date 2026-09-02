// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import { type JobContext, runWithJobContextAsync } from './job.js';
import { flushOtelLogs } from './telemetry/index.js';
import { IdleTimeoutError, waitUntilTimeout } from './utils.js';
import type { AgentSession } from './voice/agent_session.js';

export const DEFAULT_SESSION_END_TIMEOUT = 300 * 1000;
const ENTRYPOINT_SHUTDOWN_TIMEOUT = 15 * 1000;
const SESSION_CLOSE_TIMEOUT = 60 * 1000;
const OTEL_LOG_FLUSH_TIMEOUT = 10 * 1000;
const MAX_TIMER_TIMEOUT = 2_147_483_647;

type SessionEndCallback = (ctx: JobContext) => unknown;
type ShutdownCallback = () => Promise<void>;

export function validateSessionEndTimeout(timeout: number): number {
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new TypeError('sessionEndTimeout must be a finite, non-negative number');
  }
  if (timeout > MAX_TIMER_TIMEOUT) {
    throw new TypeError(`sessionEndTimeout must not exceed ${MAX_TIMER_TIMEOUT} milliseconds`);
  }
  return timeout;
}

async function waitOrContinue(
  work: () => unknown,
  timeout: number,
  logger: Logger,
  messages: {
    timeout: string;
    error: string;
    lateReject: string;
    timeoutLevel?: 'error' | 'warn';
  },
): Promise<void> {
  const workPromise = Promise.resolve().then(work);
  try {
    await waitUntilTimeout(workPromise, timeout);
  } catch (error) {
    if (!(error instanceof IdleTimeoutError)) {
      logger.error({ error }, messages.error);
      return;
    }

    void workPromise.catch((lateError) => {
      logger.debug({ error: lateError }, messages.lateReject);
    });
    if (messages.timeoutLevel === 'warn') {
      logger.warn({ timeout }, messages.timeout);
    } else {
      logger.error({ timeout }, messages.timeout);
    }
  }
}

export async function waitForEntrypointShutdown(
  entrypointPromise: Promise<unknown>,
  logger: Logger,
): Promise<void> {
  await waitOrContinue(() => entrypointPromise, ENTRYPOINT_SHUTDOWN_TIMEOUT, logger, {
    timeout: 'entrypoint did not exit in time; proceeding with session cleanup',
    error: 'error in entry function',
    lateReject: 'entrypoint rejected after shutdown timeout',
    timeoutLevel: 'warn',
  });
}

export async function closeAgentSession(
  session: Pick<AgentSession, 'close'>,
  logger: Logger,
): Promise<void> {
  await waitOrContinue(() => session.close(), SESSION_CLOSE_TIMEOUT, logger, {
    timeout:
      'AgentSession.close() timed out; proceeding with shutdown so registered callbacks still run.',
    error:
      'AgentSession.close() failed; proceeding with shutdown so registered callbacks still run.',
    lateReject: 'AgentSession.close() rejected after shutdown timeout',
  });
}

export async function finalizeSession(
  ctx: JobContext,
  onSessionEnd: SessionEndCallback | undefined,
  sessionEndTimeout: number,
  logger: Logger,
): Promise<void> {
  await runWithJobContextAsync(ctx, async () => {
    if (onSessionEnd) {
      await waitOrContinue(() => onSessionEnd(ctx), sessionEndTimeout, logger, {
        timeout: 'onSessionEnd timed out; proceeding with internal session cleanup',
        error: 'error while executing the onSessionEnd callback',
        lateReject: 'onSessionEnd rejected after shutdown timeout',
      });
    }

    try {
      await ctx._onSessionEnd();
    } catch (error) {
      logger.error({ error }, 'error in ctx._onSessionEnd');
    }
  });
}

export async function runShutdownCallbacks(
  callbacks: readonly ShutdownCallback[],
  logger: Logger,
): Promise<void> {
  const results = await Promise.allSettled(
    callbacks.map((callback) => Promise.resolve().then(() => callback())),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error({ error: result.reason }, 'error while running shutdown callback');
    }
  }
}

export async function flushJobLogs(logger: Logger): Promise<void> {
  await waitOrContinue(() => flushOtelLogs(), OTEL_LOG_FLUSH_TIMEOUT, logger, {
    timeout: 'OTEL log flush timed out; proceeding with job shutdown',
    error: 'Failed to flush OTEL logs',
    lateReject: 'OTEL log flush rejected after shutdown timeout',
  });
}
