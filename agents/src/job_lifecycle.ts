// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { callbackName } from './ipc/job_trace.js';
import { type JobContext, runWithJobContextAsync } from './job.js';
import {
  flushCloudMetrics,
  flushCloudTraces,
  flushOtelLogs,
  recordException,
  traceTypes,
  tracer,
} from './telemetry/index.js';
import { IdleTimeoutError, waitUntilTimeout } from './utils.js';

export const DEFAULT_SESSION_END_TIMEOUT = 300 * 1000;
const ENTRYPOINT_SHUTDOWN_TIMEOUT = 15 * 1000;
const SESSION_CLOSE_TIMEOUT = 60 * 1000;
const OTEL_LOG_FLUSH_TIMEOUT = 10 * 1000;
const OTEL_METRIC_FLUSH_TIMEOUT = 10 * 1000;
const OTEL_TRACE_FLUSH_TIMEOUT = 10 * 1000;
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
    /** Span that records the timeout or error of the work, when it is traced. */
    span?: Span;
  },
): Promise<boolean> {
  const workPromise = Promise.resolve().then(work);
  try {
    await waitUntilTimeout(workPromise, timeout);
    return true;
  } catch (error) {
    if (messages.span) {
      recordException(messages.span, error instanceof Error ? error : new Error(String(error)));
    }
    if (!(error instanceof IdleTimeoutError)) {
      logger.error({ error }, messages.error);
      return false;
    }

    void workPromise.catch((lateError) => {
      logger.debug({ error: lateError }, messages.lateReject);
    });
    if (messages.timeoutLevel === 'warn') {
      logger.warn({ timeout }, messages.timeout);
    } else {
      logger.error({ timeout }, messages.timeout);
    }
    return false;
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

export async function finalizeSession(
  ctx: JobContext,
  onSessionEnd: SessionEndCallback | undefined,
  sessionEndTimeout: number,
  logger: Logger,
): Promise<void> {
  const session = ctx._primaryAgentSession;
  const sessionClosed =
    !session ||
    (await waitOrContinue(() => session.close(), SESSION_CLOSE_TIMEOUT, logger, {
      timeout:
        'AgentSession.close() timed out; proceeding with shutdown without running onSessionEnd.',
      error: 'AgentSession.close() failed; proceeding with shutdown without running onSessionEnd.',
      lateReject: 'AgentSession.close() rejected after shutdown timeout',
    }));

  await runWithJobContextAsync(ctx, async () => {
    if (sessionClosed && onSessionEnd) {
      await tracer.startActiveSpan(
        (span) =>
          waitOrContinue(() => onSessionEnd(ctx), sessionEndTimeout, logger, {
            timeout: 'onSessionEnd timed out; proceeding with internal session cleanup',
            error: 'error while executing the onSessionEnd callback',
            lateReject: 'onSessionEnd rejected after shutdown timeout',
            span,
          }),
        {
          name: 'on_session_end',
          attributes: { [traceTypes.ATTR_CALLBACK_NAME]: callbackName(onSessionEnd) },
        },
      );
    }

    await tracer.startActiveSpan(
      async (span) => {
        try {
          await ctx._onSessionEnd();
        } catch (error) {
          recordException(span, error instanceof Error ? error : new Error(String(error)));
          logger.error({ error }, 'error in ctx._onSessionEnd');
        }
      },
      { name: 'session_end_upload' },
    );
  });
}

/**
 * Run the job's shutdown callbacks concurrently, one `shutdown_callback` span each named by
 * `lk.callback.name`: a hung callback here is why jobs hit the supervisor's shutdown deadline.
 */
export async function runShutdownCallbacks(
  callbacks: readonly ShutdownCallback[],
  logger: Logger,
): Promise<void> {
  const results = await Promise.allSettled(
    callbacks.map((callback) =>
      tracer.startActiveSpan(
        async (span) => {
          try {
            await callback();
          } catch (error) {
            recordException(span, error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        },
        {
          name: 'shutdown_callback',
          attributes: { [traceTypes.ATTR_CALLBACK_NAME]: callbackName(callback) },
        },
      ),
    ),
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

/** Export the job's remaining spans. Run it after the job's root span has ended. */
export async function flushJobTraces(logger: Logger): Promise<void> {
  await waitOrContinue(() => flushCloudTraces(), OTEL_TRACE_FLUSH_TIMEOUT, logger, {
    timeout: 'OTEL trace flush timed out; proceeding with job shutdown',
    error: 'Failed to flush OTEL traces',
    lateReject: 'OTEL trace flush rejected after shutdown timeout',
  });
}

/** Export the last metrics of the job. Run it after everything that can still record one. */
export async function flushJobMetrics(logger: Logger): Promise<void> {
  await waitOrContinue(() => flushCloudMetrics(), OTEL_METRIC_FLUSH_TIMEOUT, logger, {
    timeout: 'OTEL metric flush timed out; proceeding with job shutdown',
    error: 'Failed to flush OTEL metrics',
    lateReject: 'OTEL metric flush rejected after shutdown timeout',
  });
}
