// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Context } from '@opentelemetry/api';
import { getJobContext } from '../job.js';
import type { AgentSession } from '../voice/agent_session.js';

type SessionWithLoopTelemetry = AgentSession & {
  _recordLoopStall?: (durationInS: number, timestamp: number) => void;
};

/** The primary agent session in the active job, if one exists. @internal */
export function primarySession(): AgentSession | undefined {
  return getJobContext(false)?._primaryAgentSession;
}

/** The primary session's root trace context, if the session is running. @internal */
export function sessionRootContext(): Context | undefined {
  return primarySession()?.rootSpanContext;
}

/** Record a stall on the active session when a session integration is available. @internal */
export function recordLoopStall(durationInS: number, timestamp: number): void {
  const session = primarySession();
  if (!session) return;
  (session as SessionWithLoopTelemetry)._recordLoopStall?.(durationInS, timestamp);
}
