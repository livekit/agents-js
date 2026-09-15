// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';
import type { JobContext, RunningJobInfo } from '../job.js';
import { traceTypes, tracer } from '../telemetry/index.js';

/**
 * The job's root span, `job_entrypoint`, back-dated to the availability request; ended by the
 * job runner after the shutdown sequence.
 */
export function startJobSpan(ctx: JobContext, entrypointStartedAt = Date.now()): Span {
  const job = ctx.job;
  const info = ctx.info;
  const span = tracer.startSpan({
    name: 'job_entrypoint',
    startTime: info.receivedAt,
    attributes: {
      [traceTypes.ATTR_JOB_ID]: job.id,
      [traceTypes.ATTR_AGENT_NAME]: job.agentName,
      [traceTypes.ATTR_ROOM_NAME]: job.room?.name ?? '',
      [traceTypes.ATTR_ROOM_SID]: job.room?.sid ?? '',
      [traceTypes.ATTR_DISPATCH_ID]: job.dispatchId,
      [traceTypes.ATTR_WORKER_ID]: info.workerId,
      [traceTypes.ATTR_JOB_AGENT_ID]: job.state?.agentId ?? '',
    },
  });
  recordDispatchTimeline(span, info, entrypointStartedAt);
  return span;
}

/**
 * Stamp the dispatch stages on `span`: one timestamped event per stage instant, and the seconds
 * between adjacent stages as attributes (they sum to the dispatch latency).
 *
 * Timestamps travel from the worker in the running job info (epoch ms); an unknown stage
 * (simulation, console) is skipped rather than guessed.
 */
export function recordDispatchTimeline(
  span: Span,
  info: Pick<RunningJobInfo, 'receivedAt' | 'acceptedAt' | 'assignedAt' | 'launchedAt' | 'job'>,
  entrypointStartedAt: number,
): void {
  const stages: [string, number | undefined][] = [
    ['job_received', info.receivedAt],
    ['job_accepted', info.acceptedAt],
    ['job_assigned', info.assignedAt],
    ['process_assigned', info.launchedAt],
    ['entrypoint_started', entrypointStartedAt],
  ];
  for (const [name, at] of stages) {
    if (at) span.addEvent(name, undefined, at);
  }

  const gap = (attr: string, start: number | undefined, end: number | undefined) => {
    if (start && end) span.setAttribute(attr, Math.max(end - start, 0) / 1000);
  };
  gap(traceTypes.ATTR_JOB_ACCEPT_LATENCY, info.receivedAt, info.acceptedAt);
  gap(traceTypes.ATTR_JOB_ASSIGNMENT_LATENCY, info.acceptedAt, info.assignedAt);
  gap(traceTypes.ATTR_JOB_LAUNCH_LATENCY, info.assignedAt, info.launchedAt);
  gap(traceTypes.ATTR_JOB_ENTRYPOINT_LATENCY, info.launchedAt, entrypointStartedAt);
  gap(traceTypes.ATTR_JOB_DISPATCH_LATENCY, info.receivedAt, entrypointStartedAt);

  const serverStarted = info.job.state?.startedAt;
  if (serverStarted !== undefined && serverStarted > 0) {
    // the server's own start time, for lining up with server-side traces
    span.addEvent('job_started_on_server', undefined, serverTimestampMs(serverStarted));
  }
}

/**
 * `JobState` timestamps are int64; the server writes unix nanoseconds. Tolerant of milliseconds
 * and seconds should that ever change. Returns epoch milliseconds.
 */
export function serverTimestampMs(value: bigint | number): number {
  const n = Number(value);
  if (n > 1e17) return n / 1e6;
  if (n > 1e11) return n;
  return n * 1000;
}

/** How a callback is named on its span: the function's name, or `anonymous`. */
export function callbackName(fn: unknown): string {
  const name = (fn as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : 'anonymous';
}
