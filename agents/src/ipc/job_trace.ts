// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { JobJoinTiming } from '@livekit/protocol';
import type { Span } from '@opentelemetry/api';
import type { JobContext, RunningJobInfo } from '../job.js';
import { traceTypes, tracer } from '../telemetry/index.js';

/**
 * The job's root span, `job_entrypoint`, back-dated to the availability request; ended by the
 * job runner after the shutdown sequence. `entrypointStartedAt` is `null` for a job whose
 * entrypoint will not run (a shutdown arrived first): the dispatch stages up to the process
 * are recorded, the entrypoint stage and the latencies ending at it are not.
 */
export function startJobSpan(
  ctx: JobContext,
  entrypointStartedAt: number | null = Date.now(),
): Span {
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
      [traceTypes.ATTR_GEN_AI_CONVERSATION_ID]: job.room?.sid || undefined,
      [traceTypes.ATTR_DISPATCH_ID]: job.dispatchId,
      [traceTypes.ATTR_WORKER_ID]: info.workerId,
      [traceTypes.ATTR_JOB_AGENT_ID]: job.state?.agentId ?? '',
    },
  });
  recordDispatchTimeline(span, info, entrypointStartedAt ?? undefined);
  return span;
}

/**
 * Stamp the dispatch stages on `span`: one timestamped event per stage instant, and the seconds
 * between adjacent stages as attributes (they sum to the dispatch latency).
 *
 * Timestamps travel from the worker in the running job info (epoch ms); an unknown stage
 * (simulation, console) is skipped rather than guessed, as is the entrypoint stage of a job
 * whose entrypoint never ran.
 */
export function recordDispatchTimeline(
  span: Span,
  info: Pick<RunningJobInfo, 'receivedAt' | 'acceptedAt' | 'assignedAt' | 'launchedAt' | 'job'>,
  entrypointStartedAt: number | undefined,
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
 * Microseconds on the host's monotonic clock. Unlike `performance.now()`, its origin is shared by
 * every process on the host, so the worker and its job processes can compare their readings.
 */
export function monotonicUs(): number {
  return Number(process.hrtime.bigint() / 1000n);
}

/**
 * The worker-side instants of the join, for the server's job status update. Undefined when one
 * is unknown (simulation, console): a missing instant would arrive as 0, which the server cannot
 * tell apart from a real one.
 */
export function joinTiming(
  info: Pick<
    RunningJobInfo,
    'receivedMonoUs' | 'acceptedMonoUs' | 'assignedMonoUs' | 'launchedMonoUs' | 'launchedWarm'
  >,
  entrypointStartedMonoUs: number,
  connectCalledMonoUs: number,
  connectedMonoUs: number,
): JobJoinTiming | undefined {
  const stamps = [
    info.receivedMonoUs,
    info.acceptedMonoUs,
    info.assignedMonoUs,
    info.launchedMonoUs,
    entrypointStartedMonoUs,
    connectCalledMonoUs,
    connectedMonoUs,
  ];
  if (!stamps.every((s) => s)) return undefined;
  const [received, accepted, assigned, launched, entrypoint, connectCalled, connected] = stamps.map(
    (s) => BigInt(s!),
  );
  return new JobJoinTiming({
    offerReceivedUs: received,
    acceptedUs: accepted,
    assignmentReceivedUs: assigned,
    launchedUs: launched,
    launchWarm: info.launchedWarm ?? false,
    entrypointStartedUs: entrypoint,
    connectCalledUs: connectCalled,
    connectedUs: connected,
  });
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
