// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import type { JobContext } from './job.js';
import { flushOtelLogs } from './telemetry/index.js';
import { IdleTimeoutError, waitUntilTimeout } from './utils.js';
import type { AgentSession } from './voice/agent_session.js';

export const DEFAULT_SESSION_END_TIMEOUT = 300 * 1000;
const SESSION_CLOSE_TIMEOUT = 60 * 1000;
const OTEL_LOG_FLUSH_TIMEOUT = 10 * 1000;

type SessionEndCallback = (ctx: JobContext) => unknown;

export async function closeAgentSession(
  session: Pick<AgentSession, 'close'>,
  logger: Logger,
): Promise<void> {
  const sessionClosePromise = session.close();
  try {
    await waitUntilTimeout(sessionClosePromise, SESSION_CLOSE_TIMEOUT);
  } catch (error) {
    if (!(error instanceof IdleTimeoutError)) {
      throw error;
    }

    void sessionClosePromise.catch((sessionCloseError) =>
      logger.debug(
        { error: sessionCloseError },
        'AgentSession.close() rejected after shutdown timeout',
      ),
    );
    logger.error(
      { timeout: SESSION_CLOSE_TIMEOUT },
      'AgentSession.close() timed out; proceeding with shutdown so registered callbacks still run.',
    );
  }
}

export async function finalizeSession(
  ctx: JobContext,
  onSessionEnd: SessionEndCallback | undefined,
  sessionEndTimeout: number,
  logger: Logger,
): Promise<void> {
  if (onSessionEnd) {
    const callbackPromise = Promise.resolve().then(() => onSessionEnd(ctx));
    try {
      await waitUntilTimeout(callbackPromise, sessionEndTimeout);
    } catch (error) {
      if (error instanceof IdleTimeoutError) {
        void callbackPromise.catch((callbackError) =>
          logger.debug({ error: callbackError }, 'onSessionEnd rejected after shutdown timeout'),
        );
        logger.error(
          { timeout: sessionEndTimeout },
          'onSessionEnd timed out; proceeding with internal session cleanup',
        );
      } else {
        logger.error({ error }, 'error while executing the onSessionEnd callback');
      }
    }
  }

  try {
    await ctx._onSessionEnd();
  } catch (error) {
    logger.error({ error }, 'error in ctx._onSessionEnd');
  }
}

export async function flushJobLogs(logger: Logger): Promise<void> {
  const flushPromise = flushOtelLogs();
  try {
    await waitUntilTimeout(flushPromise, OTEL_LOG_FLUSH_TIMEOUT);
  } catch (error) {
    if (error instanceof IdleTimeoutError) {
      void flushPromise.catch((flushError) =>
        logger.debug({ error: flushError }, 'OTEL log flush rejected after shutdown timeout'),
      );
      logger.error(
        { timeout: OTEL_LOG_FLUSH_TIMEOUT },
        'OTEL log flush timed out; proceeding with job shutdown',
      );
    } else {
      logger.error({ error }, 'Failed to flush OTEL logs');
    }
  }
}
