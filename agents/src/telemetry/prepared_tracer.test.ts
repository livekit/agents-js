// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The trace pipeline prepared at job start: the gate holds a job's early spans until
 * `session.start()` decides whether the job records, then uploads or drops them.
 */
import {
  ProxyTracerProvider,
  SpanStatusCode,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { ATTRIBUTE_REDACTION_ENABLED } from '../types.js';
import { REDACTED_EXCEPTION_MESSAGE } from './redaction.js';
import { JobSpanGateExporter, MAX_PENDING_SPANS_PER_JOB } from './span_gate.js';
import * as traceTypes from './trace_types.js';
import {
  _resetPreparedCloudTracer,
  discardPreparedCloudTracer,
  prepareCloudTracer,
  setTracerProvider,
  setupCloudTracer,
  tracer,
} from './traces.js';
import { UploadGateTraceExporter } from './upload_gate.js';

initializeLogger({ pretty: false, level: 'silent' });

function fakeSpan(jobId: string, name = 'room_connect', extra: Record<string, unknown> = {}) {
  return {
    name,
    attributes: { job_id: jobId, ...extra },
    events: [],
    status: { code: SpanStatusCode.UNSET },
  } as unknown as ReadableSpan;
}

function fakeInner() {
  return {
    export: vi.fn((_spans: ReadableSpan[], cb: (r: { code: number }) => void) =>
      cb({ code: ExportResultCode.SUCCESS }),
    ),
    shutdown: vi.fn(async () => undefined),
    forceFlush: vi.fn(async () => undefined),
  } satisfies SpanExporter;
}

const exported = (inner: ReturnType<typeof fakeInner>) =>
  inner.export.mock.calls.flatMap((call) => call[0]);

describe('job span gate', () => {
  it('holds spans of undecided jobs, then uploads or drops them with the decision', () => {
    const inner = fakeInner();
    const gate = new JobSpanGateExporter(inner);
    const done = vi.fn();

    // not open, not registered: dropped
    gate.export([fakeSpan('job-unknown')], done);
    expect(done).toHaveBeenLastCalledWith({ code: ExportResultCode.SUCCESS });
    expect(inner.export).not.toHaveBeenCalled();

    // open and undecided: held, oldest first, bounded
    gate.openJob('job-1');
    const early = [0, 1, 2].map((i) => fakeSpan('job-1', `early-${i}`));
    gate.export(early, done);
    expect(inner.export).not.toHaveBeenCalled();
    gate.export(
      Array.from({ length: MAX_PENDING_SPANS_PER_JOB }, () => fakeSpan('job-1', 'overflow')),
      done,
    );
    expect(gate.heldSpans('job-1')).toHaveLength(MAX_PENDING_SPANS_PER_JOB);
    expect(gate.heldSpans('job-1').slice(0, 3)).toEqual(early);

    // the decision: traces on -> everything held is exported, in order
    gate.jobRegistered('job-1', { tracesEnabled: true });
    expect(exported(inner).slice(0, 3)).toEqual(early);
    expect(exported(inner)).toHaveLength(MAX_PENDING_SPANS_PER_JOB);
    expect(gate.heldSpans('job-1')).toEqual([]);
    // and later spans of the registered job pass straight through
    inner.export.mockClear();
    const late = fakeSpan('job-1', 'agent_turn');
    gate.export([late], done);
    expect(exported(inner)).toEqual([late]);

    // traces off -> dropped, now and later
    inner.export.mockClear();
    gate.openJob('job-2');
    gate.export([fakeSpan('job-2')], done);
    gate.jobRegistered('job-2', { tracesEnabled: false });
    gate.export([fakeSpan('job-2')], done);
    expect(inner.export).not.toHaveBeenCalled();
    expect(gate.heldSpans('job-2')).toEqual([]);

    // never registered -> dropped at close, and no longer held afterwards
    gate.openJob('job-3');
    gate.export([fakeSpan('job-3')], done);
    gate.closeJob('job-3');
    expect(gate.heldSpans('job-3')).toEqual([]);
    expect(gate.isOpen('job-3')).toBe(false);
    gate.export([fakeSpan('job-3')], done);
    expect(inner.export).not.toHaveBeenCalled();
  });

  it('redacts held spans when the job registers with redaction on', () => {
    // a span that ended before session.start() decided on redaction went through the PII
    // processor with redaction off: the held span is stripped before it is released
    const inner = fakeInner();
    const gate = new JobSpanGateExporter(inner);
    gate.openJob('job-1');
    const held = {
      name: 'rpc_handler',
      attributes: {
        job_id: 'job-1',
        'lk.pii.rpc.payload': "the caller's private payload",
        'lk.rpc.method': 'test_call',
        [traceTypes.ATTR_EXCEPTION_MESSAGE]: "failed on 'private text'",
      },
      events: [
        { name: 'exception', time: [0, 0], attributes: { 'exception.message': 'private text' } },
        { name: 'gen_ai.user.message', time: [0, 0], attributes: {} },
      ],
      status: { code: SpanStatusCode.ERROR, message: "failed on 'private text'" },
    } as unknown as ReadableSpan;
    gate.export([held], vi.fn());
    expect(inner.export).not.toHaveBeenCalled();

    gate.jobRegistered('job-1', { tracesEnabled: true, redacted: true });
    const [released] = exported(inner);
    expect(released!.attributes['lk.pii.rpc.payload']).toBeUndefined();
    expect(released!.attributes['lk.rpc.method']).toBe('test_call');
    expect(released!.attributes[traceTypes.ATTR_EXCEPTION_MESSAGE]).toBe(
      REDACTED_EXCEPTION_MESSAGE,
    );
    expect(released!.status.message).toBe(REDACTED_EXCEPTION_MESSAGE);
    expect(released!.events.map((event) => event.name)).toEqual(['exception']);
    expect(released!.events[0]!.attributes?.['exception.message']).toBe(REDACTED_EXCEPTION_MESSAGE);
    // the original is untouched
    expect(held.attributes['lk.pii.rpc.payload']).toBe("the caller's private payload");
  });

  it('waits for a release upload in forceFlush, so exit cannot truncate it', async () => {
    // the release runs outside the batch processor, whose flush only covers its own batches:
    // a short job's job_entrypoint would be cut off by process.exit() otherwise
    let finishRelease: (() => void) | undefined;
    const inner = fakeInner();
    inner.export.mockImplementation((_spans, cb) => {
      finishRelease = () => cb({ code: ExportResultCode.SUCCESS });
    });
    const gate = new JobSpanGateExporter(inner);
    gate.openJob('job-1');
    gate.export([fakeSpan('job-1', 'job_entrypoint')], vi.fn());
    gate.jobRegistered('job-1', { tracesEnabled: true });
    expect(finishRelease).toBeDefined();

    let flushed = false;
    const flush = gate.forceFlush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);
    expect(inner.forceFlush).not.toHaveBeenCalled();

    finishRelease!();
    await flush;
    expect(flushed).toBe(true);
    // and the exporter's own flush still runs after it, for its other in-flight requests
    expect(inner.forceFlush).toHaveBeenCalledTimes(1);
    // nothing left once settled: a later flush returns at once
    await gate.forceFlush();
  });
});

describe('prepared cloud tracer', () => {
  let prevKey: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevKey = process.env.LIVEKIT_API_KEY;
    prevSecret = process.env.LIVEKIT_API_SECRET;
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';
    setTracerProvider(new ProxyTracerProvider());
  });

  afterEach(async () => {
    await _resetPreparedCloudTracer();
    setTracerProvider(new ProxyTracerProvider());
    trace.disable();
    otelContext.disable();
    vi.restoreAllMocks();
    if (prevKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevSecret;
  });

  const cloudExports = () =>
    vi.spyOn(UploadGateTraceExporter.prototype, 'export').mockImplementation((spans, cb) => {
      seen.push(...spans);
      cb({ code: ExportResultCode.SUCCESS });
    });
  let seen: ReadableSpan[] = [];

  const flush = () => (tracer.getProvider() as NodeTracerProvider).forceFlush();

  it('holds the early spans of a prepared job until it registers, then uploads them', async () => {
    seen = [];
    cloudExports();
    await prepareCloudTracer({
      roomId: 'RM_1',
      jobId: 'AJ_1',
      observabilityUrl: 'https://example.livekit.cloud',
    });
    // the pipeline is up: the job's first span records...
    const provider = tracer.getProvider();
    expect(provider).toBeInstanceOf(NodeTracerProvider);
    const early = tracer.startSpan({ name: 'job_entrypoint' });
    expect(early.isRecording()).toBe(true);
    early.end();
    // ...but nothing is uploaded before the job decides
    await flush();
    expect(seen).toEqual([]);

    // registering releases what was held, with the job stamped on it
    await setupCloudTracer({
      roomId: 'RM_1',
      jobId: 'AJ_1',
      observabilityUrl: 'https://example.livekit.cloud',
      enableLogs: false,
      metadata: { 'lk.simulation.enabled': true },
    });
    expect(tracer.getProvider()).toBe(provider); // the prepared provider, not a second one
    expect(seen.map((span) => span.name)).toEqual(['job_entrypoint']);
    expect(seen[0]!.attributes.job_id).toBe('AJ_1');

    // later spans pass straight through and carry the session metadata
    tracer.startSpan({ name: 'agent_turn' }).end();
    await flush();
    expect(seen.map((span) => span.name)).toEqual(['job_entrypoint', 'agent_turn']);
    expect(seen[1]!.attributes['lk.simulation.enabled']).toBe(true);
  });

  it('drops the held spans of a job that never registers, or registers without traces', async () => {
    seen = [];
    cloudExports();
    await prepareCloudTracer({
      roomId: 'RM_1',
      jobId: 'AJ_1',
      observabilityUrl: 'https://example.livekit.cloud',
    });
    tracer.startSpan({ name: 'room_connect' }).end();
    await flush();
    discardPreparedCloudTracer('AJ_1'); // recording never enabled: cleanup drops it
    tracer.startSpan({ name: 'late' }).end();
    await flush();
    expect(seen).toEqual([]);

    // a second job in the same process: same pipeline, its own hold; traces off drops it
    await prepareCloudTracer({
      roomId: 'RM_2',
      jobId: 'AJ_2',
      observabilityUrl: 'https://example.livekit.cloud',
    });
    tracer.startSpan({ name: 'job_entrypoint' }).end();
    await flush();
    await setupCloudTracer({
      roomId: 'RM_2',
      jobId: 'AJ_2',
      observabilityUrl: 'https://example.livekit.cloud',
      enableTraces: false,
      enableLogs: false,
    });
    expect(seen).toEqual([]);
  });

  it('redacts held spans when the job registers with redaction', async () => {
    seen = [];
    cloudExports();
    await prepareCloudTracer({
      roomId: 'RM_1',
      jobId: 'AJ_1',
      observabilityUrl: 'https://example.livekit.cloud',
    });
    const span = tracer.startSpan({
      name: 'on_user_turn_completed',
      attributes: { 'lk.pii.user_transcript': 'my card number is 4111' },
    });
    span.end();
    await flush();
    await setupCloudTracer({
      roomId: 'RM_1',
      jobId: 'AJ_1',
      observabilityUrl: 'https://example.livekit.cloud',
      enableLogs: false,
      metadata: { [ATTRIBUTE_REDACTION_ENABLED]: true },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.attributes['lk.pii.user_transcript']).toBeUndefined();
  });
});
