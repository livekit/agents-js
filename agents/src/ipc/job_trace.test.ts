// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job, JobState, Room as ProtoRoom } from '@livekit/protocol';
import type { Room } from '@livekit/rtc-node';
import { ROOT_CONTEXT, context as otelContext, trace } from '@opentelemetry/api';
import { hrTimeToMilliseconds } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobContext, JobProcess, type RunningJobInfo } from '../job.js';
import { initializeLogger } from '../log.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import type { InferenceExecutor } from './inference_executor.js';
import {
  callbackName,
  recordDispatchTimeline,
  serverTimestampMs,
  startJobSpan,
} from './job_trace.js';

initializeLogger({ pretty: false, level: 'silent' });

const T0 = 1_700_000_000_000; // realistic epoch ms: the server timestamp unit detection needs it

function job(state: Partial<JobState> = {}): Job {
  return new Job({
    id: 'AJ_1',
    dispatchId: 'AD_1',
    agentName: 'demo',
    room: new ProtoRoom({ name: 'room-1', sid: 'RM_1' }),
    state: new JobState({ workerId: 'W_1', agentId: 'AG_1', ...state }),
  });
}

function info(
  timestamps: Partial<
    Pick<RunningJobInfo, 'receivedAt' | 'acceptedAt' | 'assignedAt' | 'launchedAt'>
  > = {},
  state: Partial<JobState> = {},
): RunningJobInfo {
  return {
    acceptArguments: { name: 'agent', identity: 'agent-1', metadata: '{}' },
    job: job(state),
    url: 'wss://example.livekit.cloud',
    token: 'tok',
    workerId: 'W_1',
    ...timestamps,
  };
}

function mockRoom(): Room {
  return {
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(async () => undefined),
    isConnected: false,
    remoteParticipants: new Map(),
    localParticipant: { sid: 'PA_agent', identity: 'agent-1' },
  } as unknown as Room;
}

function jobContext(runningInfo: RunningJobInfo): JobContext {
  return new JobContext(
    new JobProcess(),
    runningInfo,
    mockRoom(),
    () => undefined,
    () => undefined,
    { doInference: vi.fn() } as unknown as InferenceExecutor,
  );
}

const spans = (exporter: InMemorySpanExporter, name: string): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((span) => span.name === name);
const eventNames = (span: ReadableSpan) => span.events.map((event) => event.name);
const eventMs = (span: ReadableSpan, name: string) =>
  hrTimeToMilliseconds(span.events.find((event) => event.name === name)!.time);

describe('job dispatch telemetry', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;

  beforeEach(() => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
    setTracerProvider(provider);
  });

  afterEach(async () => {
    setTracerProvider(originalProvider);
    await provider.shutdown();
    trace.disable();
    otelContext.disable();
  });

  it('stamps the stage events and the latencies between adjacent stages', () => {
    const running = info(
      { receivedAt: T0, acceptedAt: T0 + 200, assignedAt: T0 + 500, launchedAt: T0 + 600 },
      // server-side unix nanoseconds
      { startedAt: BigInt(T0 + 50) * 1_000_000n },
    );
    const span = tracer.startSpan({ name: 'job_entrypoint', startTime: T0 });
    recordDispatchTimeline(span, running, T0 + 1000);
    span.end();

    const [entry] = spans(exporter, 'job_entrypoint');
    const attrs = entry!.attributes;
    // adjacent stages in seconds, summing to the total
    expect(attrs[traceTypes.ATTR_JOB_ACCEPT_LATENCY]).toBeCloseTo(0.2);
    expect(attrs[traceTypes.ATTR_JOB_ASSIGNMENT_LATENCY]).toBeCloseTo(0.3);
    expect(attrs[traceTypes.ATTR_JOB_LAUNCH_LATENCY]).toBeCloseTo(0.1);
    expect(attrs[traceTypes.ATTR_JOB_ENTRYPOINT_LATENCY]).toBeCloseTo(0.4);
    expect(attrs[traceTypes.ATTR_JOB_DISPATCH_LATENCY]).toBeCloseTo(1.0);
    // instants are events on the timeline, not raw unix timestamps in the attribute list
    expect(Object.keys(attrs).some((key) => key.endsWith('_at'))).toBe(false);

    expect(eventNames(entry!)).toEqual([
      'job_received',
      'job_accepted',
      'job_assigned',
      'process_assigned',
      'entrypoint_started',
      'job_started_on_server',
    ]);
    expect(eventMs(entry!, 'job_received')).toBe(T0);
    expect(eventMs(entry!, 'job_accepted')).toBe(T0 + 200);
    expect(eventMs(entry!, 'job_assigned')).toBe(T0 + 500);
    expect(eventMs(entry!, 'process_assigned')).toBe(T0 + 600);
    expect(eventMs(entry!, 'entrypoint_started')).toBe(T0 + 1000);
    // nanoseconds -> hrTime -> ms round-trips within a microsecond
    expect(eventMs(entry!, 'job_started_on_server')).toBeCloseTo(T0 + 50, 2);
  });

  it('skips unknown stages rather than guessing them', () => {
    // simulation / console jobs carry no timestamps
    const span = tracer.startSpan({ name: 'job_entrypoint' });
    recordDispatchTimeline(span, info(), T0 + 1000);
    span.end();

    const [entry] = spans(exporter, 'job_entrypoint');
    expect(eventNames(entry!)).toEqual(['entrypoint_started']);
    expect(
      Object.keys(entry!.attributes).filter(
        (key) => key.startsWith('lk.job.') && key.endsWith('_latency'),
      ),
    ).toEqual([]);
  });

  it('back-dates the job span to the request and carries the join keys', () => {
    const running = info({
      receivedAt: T0,
      acceptedAt: T0 + 200,
      assignedAt: T0 + 500,
      launchedAt: T0 + 600,
    });
    const span = startJobSpan(jobContext(running), T0 + 1000);
    expect(span.isRecording()).toBe(true);
    // a child created under it (the session, a connect) nests: the root is a real span
    tracer.startSpan({ name: 'agent_session', context: trace.setSpan(ROOT_CONTEXT, span) }).end();
    span.end();

    const [root] = spans(exporter, 'job_entrypoint');
    expect(hrTimeToMilliseconds(root!.startTime)).toBe(T0);
    expect(root!.attributes[traceTypes.ATTR_JOB_ID]).toBe('AJ_1');
    expect(root!.attributes[traceTypes.ATTR_DISPATCH_ID]).toBe('AD_1');
    expect(root!.attributes[traceTypes.ATTR_WORKER_ID]).toBe('W_1');
    expect(root!.attributes[traceTypes.ATTR_JOB_AGENT_ID]).toBe('AG_1');
    expect(root!.attributes[traceTypes.ATTR_ROOM_SID]).toBe('RM_1');
    expect(root!.attributes[traceTypes.ATTR_JOB_ACCEPT_LATENCY]).toBeCloseTo(0.2);
    expect(eventNames(root!).slice(0, 4)).toEqual([
      'job_received',
      'job_accepted',
      'job_assigned',
      'process_assigned',
    ]);
    const [session] = spans(exporter, 'agent_session');
    expect(session!.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);
  });

  it('reads server timestamps in nanoseconds, milliseconds, or seconds', () => {
    expect(serverTimestampMs(1_700_000_000_123_456_789n)).toBeCloseTo(1_700_000_000_123.456, 2);
    expect(serverTimestampMs(1_700_000_000_123)).toBe(1_700_000_000_123);
    expect(serverTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it('names callbacks by their function name', () => {
    async function flushCrm() {}
    expect(callbackName(flushCrm)).toBe('flushCrm');
    expect(callbackName(() => undefined)).toBe('anonymous');
  });
});
