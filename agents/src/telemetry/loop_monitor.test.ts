// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, getJobContext, runWithJobContext } from '../job.js';
import { log } from '../log.js';
import {
  type BlockedReport,
  DEFAULT_ERROR_THRESHOLD,
  DEFAULT_WARN_THRESHOLD,
  ENV_ERROR_THRESHOLD_MS,
  ENV_WARN_THRESHOLD_MS,
  EventLoopMonitor,
  LoopMonitorThresholds,
  MAX_LOGS_PER_MINUTE,
  MAX_SPANS_PER_MINUTE,
  SPAN_NAME,
  getMonitor,
  startMonitoring,
  stopMonitoring,
} from './loop_monitor.js';
import * as otelMetrics from './otel_metrics.js';
import { RateLimiter } from './rate_limiter.js';
import {
  ATTR_BLOCKING_CAUSE,
  ATTR_BLOCKING_CPU_TIME,
  ATTR_BLOCKING_DURATION,
  ATTR_BLOCKING_GC_TIME,
  ATTR_BLOCKING_SEVERITY,
  ATTR_BLOCKING_SUPPRESSED,
  ATTR_BLOCKING_THRESHOLD,
} from './trace_types.js';
import { setTracerProvider, tracer } from './traces.js';

const WARN = 30;
const ERROR = 150;
const TICK = 5;

function blockLoop(duration: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

/** Block the loop while allocating heavily, so V8 has to collect during the block. */
function blockLoopWithGarbage(duration: number): void {
  const until = performance.now() + duration;
  let garbage: unknown[] = [];
  while (performance.now() < until) {
    garbage.push(new Array(1000).fill({ x: 1 }));
    if (garbage.length > 20_000) garbage = [];
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TICK * 4));
}

/** Wait until the watchdog thread has woken at least once, so it can vouch for the process. */
async function watchdogReady(monitor: EventLoopMonitor): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!monitor.watchdogActive && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, WARN));
}

function fakeJob(session?: unknown): JobContext {
  return {
    _primaryAgentSession: session,
    job: { id: 'AJ_test', room: { sid: 'RM_test' } },
  } as unknown as JobContext;
}

/** Reports that blame code on the loop. A noisy CI host can deschedule the test process too. */
function codeReports(reports: BlockedReport[]): BlockedReport[] {
  return reports.filter((report) => report.cause === 'code');
}

const timings = (cpuTime = 20, watchdogGap = 0, gcTime = 0) => ({ cpuTime, gcTime, watchdogGap });

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
      stacks: 'never', // sampled stacks have their own tests; reports stay synchronous here
    });
    monitor.onReport = (report) => reports.push(report);
    sessionRoot = tracer.startSpan({ name: 'agent_session' });
    const session = { rootSpanContext: trace.setSpan(ROOT_CONTEXT, sessionRoot) };
    const job = fakeJob(session);
    monitor.setReportContext(trace.setSpan(ROOT_CONTEXT, sessionRoot), (fn) =>
      runWithJobContext(job, fn),
    );
    monitor.start();
    await watchdogReady(monitor);
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

  /** The span of the longest stall: a loaded host can add shorter ones around a test's block. */
  function longestBlockedSpan() {
    return blockedSpans().sort(
      (a, b) =>
        (b.attributes[ATTR_BLOCKING_DURATION] as number) -
        (a.attributes[ATTR_BLOCKING_DURATION] as number),
    )[0];
  }

  it('reports a blocking call as a backdated error span', async () => {
    blockLoop(200);
    await settle();
    const span = longestBlockedSpan();
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
    expect(span!.attributes[ATTR_BLOCKING_GC_TIME]).toBe(0);
    expect(span!.attributes[ATTR_BLOCKING_CAUSE]).toBe('code');
    // the watchdog thread kept running while the loop thread waited: the process was scheduled
    const [report] = codeReports(reports).sort((a, b) => b.duration - a.duration);
    expect(report!.cause).toBe('code');
    expect(report!.watchdogGap).toBeLessThan(report!.duration * 0.5);
    // Atomics.wait parks the loop thread: per-thread accounting sees (almost) no CPU
    expect(report!.cpuScope).toBe('thread');
    expect(report!.cpuTime).toBeLessThan(report!.duration * 0.5);
  });

  it('measures the CPU of the loop thread, not of the process', async () => {
    // a worker thread burns CPU for the whole block while the loop thread only waits
    const burner = new Worker(`const t = Date.now(); while (Date.now() - t < 300) {}`, {
      eval: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    blockLoop(200);
    await settle();
    await new Promise<void>((resolve) => burner.once('exit', () => resolve()));
    const [report] = codeReports(reports).sort((a, b) => b.duration - a.duration);
    expect(report).toBeDefined();
    expect(report!.cpuTime).toBeLessThan(report!.duration * 0.5);
  });

  it('holds a stall one heartbeat and flushes it on stop', async () => {
    blockLoop(70);
    // the late tick has run (it expired during the block) but the next one has not
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toEqual([]);
    monitor.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.duration).toBeGreaterThanOrEqual(70 - TICK - 10);
  });

  it('reports a block between thresholds as a warning', async () => {
    blockLoop(70);
    await settle();
    const span = longestBlockedSpan();
    expect(span!.attributes[ATTR_BLOCKING_DURATION]).toBeLessThan(ERROR / 1000);
    expect(span!.attributes[ATTR_BLOCKING_SEVERITY]).toBe('warning');
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('attributes garbage collection pauses inside a block', async () => {
    blockLoopWithGarbage(200);
    await settle();
    // the longest stall is the block above; a loaded host can add shorter ones around it
    const report = codeReports(reports).sort((a, b) => b.duration - a.duration)[0];
    expect(report).toBeDefined();
    expect(report!.gcTime).toBeGreaterThan(0);
    expect(report!.gcTime).toBeLessThanOrEqual(report!.duration);
    const span = longestBlockedSpan();
    expect(span!.attributes[ATTR_BLOCKING_DURATION]).toBe(report!.duration / 1000);
    expect(span!.attributes[ATTR_BLOCKING_GC_TIME]).toBeCloseTo(report!.gcTime / 1000, 6);
  });

  it('does not report cooperative work', async () => {
    for (let i = 0; i < 40; i++) {
      blockLoop(2);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, WARN * 2));
    expect(codeReports(reports)).toEqual([]);
  });

  it('parents a pre-session stall to the report context', async () => {
    const entrypoint = tracer.startSpan({ name: 'job_entrypoint' });
    const context = trace.setSpan(ROOT_CONTEXT, entrypoint);
    monitor.setReportContext(context, (fn) => runWithJobContext(fakeJob(), fn));
    blockLoop(70);
    await settle();
    entrypoint.end();
    const span = longestBlockedSpan();
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

  it('does not charge the span quota for stalls that cannot have a span', () => {
    monitor.stop();
    // an idle child before its job: reports, but no job context to parent a span to
    monitor.setReportContext(undefined);
    for (let i = 0; i < MAX_SPANS_PER_MINUTE * 2; i++) {
      monitor['report'](monitor['buildReport'](100, timings()));
    }
    expect(blockedSpans()).toEqual([]);
    // the job starts: its very first stall still gets a span, with nothing counted as suppressed
    monitor.setReportContext(trace.setSpan(ROOT_CONTEXT, sessionRoot), (fn) =>
      runWithJobContext(fakeJob(), fn),
    );
    monitor['report'](monitor['buildReport'](100, timings()));
    const [span] = blockedSpans();
    expect(span).toBeDefined();
    expect(span!.attributes[ATTR_BLOCKING_SUPPRESSED]).toBeUndefined();
  });

  it('records every stall on the active session', () => {
    monitor.stop();
    const seen: [number, string][] = [];
    const job = fakeJob({
      _recordLoopStall: (duration: number, _timestamp: number, cause: string) =>
        seen.push([duration, cause]),
    });
    monitor.setReportContext(undefined, (fn) => runWithJobContext(job, fn));
    const report = monitor['buildReport'](100, timings());
    for (let i = 0; i < 40; i++) monitor['report'](report);
    expect(seen).toHaveLength(40);
    expect(seen.every(([duration, cause]) => duration === 0.1 && cause === 'code')).toBe(true);
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
    expect(codeReports(reports)).toEqual([]);
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
    expect(codeReports(reports)).toEqual([]);
  });

  it('keeps spans disabled in worker mode', async () => {
    monitor.stop();
    exporter.reset();
    const workerMonitor = new EventLoopMonitor({
      warnThreshold: WARN,
      errorThreshold: ERROR,
      tickInterval: TICK,
      emitSpans: false,
      stacks: 'never',
    });
    const workerReports: BlockedReport[] = [];
    workerMonitor.onReport = (report) => workerReports.push(report);
    workerMonitor.start();
    await watchdogReady(workerMonitor);
    blockLoop(80);
    await settle();
    workerMonitor.stop();
    expect(blockedSpans()).toEqual([]);
    expect(workerReports).toHaveLength(1);
  });

  it('records the metric for every stall past span rate limits in seconds', () => {
    monitor.stop();
    const record = vi.spyOn(otelMetrics, 'recordEventLoopBlocked').mockImplementation(() => {});
    const report = monitor['buildReport'](100, timings());
    for (let i = 0; i < 40; i++) monitor['report'](report);
    expect(record).toHaveBeenCalledTimes(40);
    expect(record).toHaveBeenCalledWith(0.1, 'warning', 'code');
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
    for (let i = 0; i < 40; i++) monitor['report'](monitor['buildReport'](100, timings()));
    expect(jobs).toHaveLength(40);
    expect(jobs.every((value) => value === job)).toBe(true);
  });

  describe('host contention', () => {
    it('is told apart from blocking code by the watchdog and the loop thread CPU', () => {
      monitor.stop();
      expect(monitor['cpuScope']).toBe('thread');
      // watchdog late by most of the stall and the loop thread burned (nearly) nothing: it
      // was not running
      const descheduled = monitor['buildReport'](400, timings(10, 300));
      expect(descheduled.cause).toBe('host');
      // watchdog on time: the loop thread alone was stuck, in a blocking wait
      expect(monitor['buildReport'](400, timings(10, 4)).cause).toBe('code');
      // watchdog starved but the loop thread was busy the whole time: contention delayed the
      // watchdog, synchronous code held the loop
      expect(monitor['buildReport'](400, timings(380, 300)).cause).toBe('code');
    });

    it('is decided by the watchdog alone when CPU time is process-wide', () => {
      monitor.stop();
      monitor['cpuScope'] = 'process';
      // native media threads burned CPU while both monitored threads starved: process-wide
      // CPU cannot pin that on the loop thread, so it must not override the watchdog
      expect(monitor['buildReport'](400, timings(250, 300)).cause).toBe('host');
      expect(monitor['buildReport'](400, timings(250, 4)).cause).toBe('code');
    });

    it('keeps the severity of its impact', () => {
      monitor.stop();
      // a stall past the error threshold delays audio the same however it came about
      expect(monitor['buildReport'](400, timings(10, 300)).severity).toBe('error');
      expect(monitor['buildReport'](70, timings(1, 60)).severity).toBe('warning');
    });

    it('is flagged as host contention on the span, the metric, the session, and the log', () => {
      monitor.stop();
      const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
      const record = vi.spyOn(otelMetrics, 'recordEventLoopBlocked').mockImplementation(() => {});
      const stalls: string[] = [];
      const session = {
        rootSpanContext: trace.setSpan(ROOT_CONTEXT, sessionRoot),
        _recordLoopStall: (_duration: number, _timestamp: number, cause: string) =>
          stalls.push(cause),
      };
      monitor.setReportContext(trace.setSpan(ROOT_CONTEXT, sessionRoot), (fn) =>
        runWithJobContext(fakeJob(session), fn),
      );
      monitor['report'](monitor['buildReport'](400, timings(10, 300)));
      const [span] = blockedSpans();
      expect(span!.attributes[ATTR_BLOCKING_CAUSE]).toBe('host');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.status.message).toContain('not scheduled');
      expect(record).toHaveBeenCalledWith(0.4, 'error', 'host');
      expect(stalls).toEqual(['host']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ cause: 'host' });
      expect(warn.mock.calls[0]![1]).toContain('CPU contention or a container CPU quota');
      expect(warn.mock.calls[0]![1]).not.toContain('synchronous work');
    });

    it('has its own log quota so neither cause silences the other', () => {
      monitor.stop();
      const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
      const host = monitor['buildReport'](400, timings(10, 300));
      for (let i = 0; i < 10; i++) monitor['report'](host);
      expect(warn).toHaveBeenCalledTimes(MAX_LOGS_PER_MINUTE);
      // a genuine block right after still has its full quota
      monitor['report'](monitor['buildReport'](400, timings(10, 4)));
      expect(warn).toHaveBeenCalledTimes(MAX_LOGS_PER_MINUTE + 1);
      expect(warn.mock.calls.at(-1)![1]).toContain('synchronous work');
    });

    it('is named as a possible cause when no watchdog is running', async () => {
      monitor.stop();
      const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
      const bare = new EventLoopMonitor({
        warnThreshold: WARN,
        errorThreshold: ERROR,
        tickInterval: TICK,
        watchdog: false,
        stacks: 'never',
      });
      bare.start();
      expect(bare.watchdogActive).toBe(false);
      const report = bare['buildReport'](400, timings(10, 0));
      expect(report.cause).toBe('code');
      bare['report'](report);
      bare.stop();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toContain('did not schedule the process');
    });
  });
});

describe.sequential('event loop monitor helpers', () => {
  afterEach(() => {
    stopMonitoring();
    vi.unstubAllEnvs();
  });

  it('rate limiter counts suppressed reports and uses a rolling window', () => {
    const limiter = new RateLimiter(2);
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
    // a NaN tick interval would become a zero-delay timer and spin the loop
    expect(() => new EventLoopMonitor({ warnThreshold: NaN })).toThrow();
    expect(() => new EventLoopMonitor({ warnThreshold: 100, errorThreshold: NaN })).toThrow();
    expect(() => new EventLoopMonitor({ warnThreshold: 100, tickInterval: NaN })).toThrow();
    expect(() => new EventLoopMonitor({ warnThreshold: Infinity })).toThrow();
  });

  it('uses a bounded fifth of the warning threshold as the tick interval', () => {
    const tickFor = (warn: number) => {
      const monitor = startMonitoring({
        thresholds: new LoopMonitorThresholds(warn, warn * 5),
        watchdog: false,
      });
      const tick = monitor!.tickInterval;
      stopMonitoring();
      return tick;
    };
    expect(tickFor(100)).toBe(20);
    expect(tickFor(250)).toBe(50);
    expect(tickFor(1000)).toBe(50);
    expect(tickFor(50)).toBe(20);
  });

  it('raises a warning threshold below the tick floor', () => {
    const monitor = startMonitoring({
      thresholds: new LoopMonitorThresholds(5, 10),
      emitSpans: false,
      watchdog: false,
    });
    expect(monitor?.warnThreshold).toBe(20);
    expect(monitor?.errorThreshold).toBe(20);
    expect(monitor?.tickInterval).toBe(20);
  });
});
