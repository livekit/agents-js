// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Trace-context helpers for the primary agent session.
 *
 * The job's trace is rooted at `job_entrypoint` and `agent_session` is a child of it, so work
 * done before or after the session (the room connect in the entrypoint, an event loop stall
 * while models load, the job's shutdown) lands under the job in the ambient context and needs
 * no special handling. What does need help is code running on a task whose context predates
 * the session, the event loop monitor's heartbeat above all: it resolves the running session
 * through the job ({@link sessionRootContext}) so its spans nest under `agent_session` while
 * one exists. {@link sessionSpan} nests startup work under `session_start` while the session is
 * starting.
 */
import type { Attributes, Context, Span } from '@opentelemetry/api';
import { type JobContext, getJobContext } from '../job.js';
import type { AgentSession } from '../voice/agent_session.js';
import { tracer } from './traces.js';

type SessionWithLoopTelemetry = AgentSession & {
  _recordLoopStall?: (durationInS: number, timestamp: number, cause: string) => void;
};

function currentJob(jobCtx?: JobContext): JobContext | undefined {
  return jobCtx ?? getJobContext(false);
}

/** The primary agent session in the active job (or `jobCtx`), if one exists. @internal */
export function primarySession(jobCtx?: JobContext): AgentSession | undefined {
  return currentJob(jobCtx)?._primaryAgentSession;
}

/** The primary session's root trace context, if the session is running. @internal */
export function sessionRootContext(jobCtx?: JobContext): Context | undefined {
  return primarySession(jobCtx)?.rootSpanContext;
}

/**
 * The job's root trace context (`job_entrypoint`), for work with no session to nest under.
 * @internal
 */
export function jobRootContext(jobCtx?: JobContext): Context | undefined {
  return currentJob(jobCtx)?._jobSpanContext;
}

/** The primary session's `session_start` context while `start()` runs. @internal */
export function sessionStartContext(jobCtx?: JobContext): Context | undefined {
  return primarySession(jobCtx)?.sessionStartContext;
}

/**
 * Run `fn` under a span for session work: under `session_start` while the primary session is
 * starting, else in the ambient context. Never made current (see `tracer.detachedSpan`):
 * `room.connect()` spawns tasks that live on. `jobCtx` resolves the session from any task.
 *
 * @internal
 */
export function sessionSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options: { attributes?: Attributes; jobCtx?: JobContext } = {},
): Promise<T> {
  return tracer.detachedSpan(fn, {
    name,
    attributes: options.attributes,
    context: sessionStartContext(options.jobCtx),
  });
}

/** Record a stall on the active session when a session integration is available. @internal */
export function recordLoopStall(durationInS: number, timestamp: number, cause: string): void {
  const session = primarySession();
  if (!session) return;
  (session as SessionWithLoopTelemetry)._recordLoopStall?.(durationInS, timestamp, cause);
}
