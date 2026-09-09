// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, getJobContext, runWithJobContext } from '../job.js';
import {
  type BlockedReport,
  DEFAULT_ERROR_THRESHOLD,
  DEFAULT_WARN_THRESHOLD,
  ENV_ERROR_THRESHOLD_MS,
  ENV_WARN_THRESHOLD_MS,
  EventLoopMonitor,
  LoopMonitorThresholds,
  MAX_SPANS_PER_MINUTE,
  SPAN_NAME,
  _RateLimiter,
  _tickIntervalFor,
  getMonitor,
  startMonitoring,
  stopMonitoring,
} from './loop_monitor.js';
import * as otelMetrics from './otel_metrics.js';
import {
  ATTR_BLOCKING_CPU_TIME,
  ATTR_BLOCKING_DURATION,
  ATTR_BLOCKING_SEVERITY,
  ATTR_BLOCKING_THRESHOLD,
} from './trace_types.js';
import { setTracerProvider, tracer } from './traces.js';

const WARN = 30;
const ERROR = 150;
const TICK = 5;

function blockLoop(duration: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TICK * 4));
}

function fakeJob(session?: unknown): JobContext {
  return {
    _primaryAgentSession: session,
    job: { id: 'AJ_test', room: { sid: 'RM_test' } },
  } as unknown as JobContext;
}

describe.sequential('event loop monitor', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;
  let monitor: EventLoopMonitor;
  let reports: BlockedReport[];
  let sessionRoot: ReturnType<typeof tracer.startSpan>;

  beforeEach(async () => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    setTracerProvider(provider);
    reports = [];
    monitor = new EventLoopMonitor({
      warnThreshold: WARN,
      errorThreshold: ERROR,
      tickInterval: TICK,
    });
    monitor._onReport = (report) => reports.push(report);
    sessionRoot = tracer.startSpan({ name: 'agent_session' });
    const session = { rootSpanContext: trace.setSpan(ROOT_CONTEXT, sessionRoot) };
    const job = fakeJob(session);
    monitor.setReportContext(trace.setSpan(ROOT_CONTEXT, sessionRoot), (fn) =>
      runWithJobContext(job, fn),
    );
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, WARN));
  });

  afterEach(async () => {
    monitor.stop();
    sessionRoot.end();
    setTracerProvider(originalProvider);
    await provider.shutdown();
    vi.restoreAllMocks();
    stopMonitoring();
  });

  function blockedSpans() {
    return exporter.getFinishedSpans().filter((span) => span.name === SPAN_NAME);
  }

  it('reports a blocking call as a backdated error span', async () => {
    blockLoop(200);
    await settle();
    const [span] = blockedSpans();
    expect(span).toBeDefined();
    const duration = span!.attributes[ATTR_BLOCKING_DURATION] as number;
    expect(duration).toBeGreaterThanOrEqual((200 - TICK - 10) / 1000);
    expect(duration).toBeLessThanOrEqual(0.3);
    expect(span!.attributes[ATTR_BLOCKING_THRESHOLD]).toBe(WARN / 1000);
    expect(span!.attributes[ATTR_BLOCKING_SEVERITY]).toBe('error');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    const elapsed =
      (span!.endTime[0] - span!.startTime[0]) * 1000 +
      (span!.endTime[1] - span!.startTime[1]) / 1e6;
    expect(elapsed).toBeCloseTo(duration * 1000, 3);
    expect(span!.attributes[ATTR_BLOCKING_CPU_TIME]).toBeTypeOf('number');
  });

  it('reports a block between thresholds as a warning', async () => {
    blockLoop(70);
    await settle();
    const [span] = blockedSpans();
    expect(span!.attributes[ATTR_BLOCKING_SEVERITY]).toBe('warning');
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('does not report cooperative work', async () => {
    for (let i = 0; i < 40; i++) {
      blockLoop(2);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, WARN * 2));
    expect(reports).toEqual([]);
  });

  it('parents a pre-session stall to the report context', async () => {
    const entrypoint = tracer.startSpan({ name: 'job_entrypoint' });
    const context = trace.setSpan(ROOT_CONTEXT, entrypoint);
    monitor.setReportContext(context, (fn) => runWithJobContext(fakeJob(), fn));
    blockLoop(70);
    await settle();
    entrypoint.end();
    const [span] = blockedSpans();
    expect(span!.parentSpanContext?.spanId).toBe(entrypoint.spanContext().spanId);
    expect(
      span!.endTime[0] < entrypoint.endTime![0] || span!.endTime[1] <= entrypoint.endTime![1],
    ).toBe(true);
  });

  it('does not emit a span without a job', async () => {
    monitor.setReportContext(undefined);
    blockLoop(70);
    await settle();
    expect(blockedSpans()).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  it('records every stall on the active session', () => {
    monitor.stop();
    const seen: number[] = [];
    const job = fakeJob({ _recordLoopStall: (duration: number) => seen.push(duration) });
    monitor.setReportContext(undefined, (fn) => runWithJobContext(job, fn));
    const report = monitor._buildReport(100, 20);
    for (let i = 0; i < 40; i++) monitor._report(report);
    expect(seen).toHaveLength(40);
    expect(seen.every((duration) => duration === 0.1)).toBe(true);
  });

  it('stops idempotently and stays quiet', async () => {
    monitor.stop();
    monitor.stop();
    blockLoop(70);
    await settle();
    expect(blockedSpans()).toEqual([]);
  });

  it('does not report an idle loop', async () => {
    await new Promise((resolve) => setTimeout(resolve, WARN * 12));
    expect(reports).toEqual([]);
  });

  it('does not report blocking work outside the event loop', async () => {
    const worker = new Worker(
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${WARN * 6})`,
      { eval: true },
    );
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', () => resolve());
    });
    await settle();
    expect(reports).toEqual([]);
  });

  it('keeps spans disabled in worker mode', async () => {
    monitor.stop();
    exporter.reset();
    const workerMonitor = new EventLoopMonitor({
      warnThreshold: WARN,
      errorThreshold: ERROR,
      tickInterval: TICK,
      emitSpans: false,
    });
    const workerReports: BlockedReport[] = [];
    workerMonitor._onReport = (report) => workerReports.push(report);
    workerMonitor.start();
    await new Promise((resolve) => setTimeout(resolve, WARN));
    blockLoop(80);
    await settle();
    workerMonitor.stop();
    expect(blockedSpans()).toEqual([]);
    expect(workerReports).toHaveLength(1);
  });

  it('records the metric for every stall past span rate limits in seconds', () => {
    monitor.stop();
    const record = vi.spyOn(otelMetrics, 'recordEventLoopBlocked').mockImplementation(() => {});
    const report = monitor._buildReport(100, 20);
    for (let i = 0; i < 40; i++) monitor._report(report);
    expect(record).toHaveBeenCalledTimes(40);
    expect(record).toHaveBeenCalledWith(0.1, 'warning');
    expect(reports).toHaveLength(MAX_SPANS_PER_MINUTE);
  });

  it('restores report context even for rate-limited metrics', () => {
    monitor.stop();
    const jobs: (JobContext | undefined)[] = [];
    const job = fakeJob();
    vi.spyOn(otelMetrics, 'recordEventLoopBlocked').mockImplementation(() => {
      jobs.push(getJobContext(false));
    });
    const context = trace.setSpan(ROOT_CONTEXT, sessionRoot);
    monitor.setReportContext(context, (fn) => runWithJobContext(job, fn));
    for (let i = 0; i < 40; i++) monitor._report(monitor._buildReport(100, 20));
    expect(jobs).toHaveLength(40);
    expect(jobs.every((value) => value === job)).toBe(true);
  });
});

describe.sequential('event loop monitor helpers', () => {
  afterEach(() => {
    stopMonitoring();
    vi.unstubAllEnvs();
  });

  it('rate limiter counts suppressed reports and uses a rolling window', () => {
    const limiter = new _RateLimiter(2);
    expect(limiter.allow(100_000)).toBe(true);
    expect(limiter.allow(100_100)).toBe(true);
    expect(limiter.allow(100_200)).toBe(false);
    expect(limiter.allow(100_300)).toBe(false);
    expect(limiter.takeSuppressed()).toBe(2);
    expect(limiter.takeSuppressed()).toBe(0);
    expect(limiter.allow(161_000)).toBe(true);
  });

  it('reads, validates, disables, and clamps environment thresholds', () => {
    expect(LoopMonitorThresholds.fromEnv({})).toEqual(
      new LoopMonitorThresholds(DEFAULT_WARN_THRESHOLD, DEFAULT_ERROR_THRESHOLD),
    );
    expect(
      LoopMonitorThresholds.fromEnv({
        [ENV_WARN_THRESHOLD_MS]: '100',
        [ENV_ERROR_THRESHOLD_MS]: '1000',
      }),
    ).toEqual(new LoopMonitorThresholds(100, 1000));
    expect(LoopMonitorThresholds.fromEnv({ [ENV_WARN_THRESHOLD_MS]: '0' })).toBeUndefined();
    for (const bad of ['fast', 'NaN', 'Infinity', '-Infinity']) {
      expect(LoopMonitorThresholds.fromEnv({ [ENV_WARN_THRESHOLD_MS]: bad })?.warn).toBe(100);
    }
    expect(
      LoopMonitorThresholds.fromEnv({
        [ENV_WARN_THRESHOLD_MS]: '200',
        [ENV_ERROR_THRESHOLD_MS]: '20',
      }),
    ).toEqual(new LoopMonitorThresholds(200, 200));
  });

  it('starts one process monitor and stops it', () => {
    const thresholds = new LoopMonitorThresholds(WARN, ERROR);
    const monitor = startMonitoring({ thresholds });
    expect(monitor).toBeDefined();
    expect(getMonitor()).toBe(monitor);
    expect(startMonitoring({ thresholds })).toBeUndefined();
    stopMonitoring();
    expect(getMonitor()).toBeUndefined();
    vi.stubEnv(ENV_WARN_THRESHOLD_MS, '0');
    expect(startMonitoring()).toBeUndefined();
  });

  it('validates constructor thresholds', () => {
    expect(() => new EventLoopMonitor({ warnThreshold: 0 })).toThrow();
    expect(() => new EventLoopMonitor({ warnThreshold: 100, errorThreshold: 50 })).toThrow();
    expect(() => new EventLoopMonitor({ warnThreshold: 10, tickInterval: 50 })).toThrow();
  });

  it('uses a bounded fifth of the warning threshold', () => {
    expect(_tickIntervalFor(100)).toBe(20);
    expect(_tickIntervalFor(250)).toBe(50);
    expect(_tickIntervalFor(1000)).toBe(50);
    expect(_tickIntervalFor(50)).toBe(20);
  });

  it('raises a warning threshold below the tick floor', () => {
    const monitor = startMonitoring({
      thresholds: new LoopMonitorThresholds(5, 10),
      emitSpans: false,
    });
    expect(monitor?.warnThreshold).toBe(20);
    expect(monitor?.errorThreshold).toBe(20);
    expect(monitor?.tickInterval).toBe(20);
  });
});
