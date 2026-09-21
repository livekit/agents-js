// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a stall lands and what it says: the `event_loop_blocked` span nests under the span that
 * was running when the loop blocked, and carries the loop thread's sampled stack.
 */
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContext } from '../job.js';
import { log } from '../log.js';
import { BlockedSpanTracker, blockedSpanTracker } from './blocked_span_tracker.js';
import { type BlockedReport, EventLoopMonitor, SPAN_NAME } from './loop_monitor.js';
import {
  ENV_STACKS,
  MAX_STACK_FRAMES,
  type StackSample,
  formatSample,
  innermostLocation,
  stackSamplingModeFromEnv,
} from './loop_stack_sampler.js';
import { ATTR_BLOCKING_STACK } from './trace_types.js';
import { setTracerProvider, tracer } from './traces.js';

const WARN = 30;
const ERROR = 150;
const TICK = 5;

/** Named so the sampled stack can be checked for it. */
function burnCpuForTest(duration: number): number {
  const until = performance.now() + duration;
  let hash = 0;
  while (performance.now() < until) {
    for (let i = 0; i < 1000; i++) hash = (hash * 31 + i) | 0;
  }
  return hash;
}

async function waitFor(condition: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeJob(session?: unknown, jobSpanContext?: unknown): JobContext {
  return {
    _primaryAgentSession: session,
    _jobSpanContext: jobSpanContext,
    job: { id: 'AJ_test', room: { sid: 'RM_test' } },
  } as unknown as JobContext;
}

describe.sequential('event loop stall parent', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;
  let monitor: EventLoopMonitor;
  let reports: BlockedReport[];

  beforeEach(async () => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [blockedSpanTracker, new SimpleSpanProcessor(exporter)],
    });
    setTracerProvider(provider);
    reports = [];
    monitor = new EventLoopMonitor({
      warnThreshold: WARN,
      errorThreshold: ERROR,
      tickInterval: TICK,
      watchdog: false,
      stacks: 'never',
    });
    monitor.onReport = (report) => reports.push(report);
  });

  afterEach(async () => {
    monitor.stop();
    setTracerProvider(originalProvider);
    await provider.shutdown();
    vi.restoreAllMocks();
  });

  function stalls() {
    return exporter.getFinishedSpans().filter((span) => span.name === SPAN_NAME);
  }

  it('nests under the span that was running when the loop blocked', async () => {
    const sessionRoot = tracer.startSpan({ name: 'agent_session' });
    const rootCtx = trace.setSpan(ROOT_CONTEXT, sessionRoot);
    monitor.setReportContext(rootCtx, (fn) =>
      runWithJobContext(fakeJob({ rootSpanContext: rootCtx }), fn),
    );
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, WARN));

    // a tool that blocks: its span is open across the stall and ends when the call returns
    const tool = tracer.startSpan({ name: 'function_tool', context: rootCtx });
    burnCpuForTest(70);
    tool.end();
    await waitFor(() => stalls().length > 0);
    sessionRoot.end();

    const [stall] = stalls();
    expect(stall!.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
  });

  it('falls back to the session root, then the job root', async () => {
    const sessionRoot = tracer.startSpan({ name: 'agent_session' });
    const rootCtx = trace.setSpan(ROOT_CONTEXT, sessionRoot);
    monitor.setReportContext(rootCtx, (fn) =>
      runWithJobContext(fakeJob({ rootSpanContext: rootCtx }), fn),
    );
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, WARN));
    burnCpuForTest(70);
    await waitFor(() => stalls().length > 0);
    expect(stalls()[0]!.parentSpanContext?.spanId).toBe(sessionRoot.spanContext().spanId);
    sessionRoot.end();
    exporter.reset();

    // no session: the job's root
    const jobRoot = tracer.startSpan({ name: 'job_entrypoint' });
    const jobCtx = trace.setSpan(ROOT_CONTEXT, jobRoot);
    monitor.setReportContext(undefined, (fn) => runWithJobContext(fakeJob(undefined, jobCtx), fn));
    burnCpuForTest(70);
    await waitFor(() => stalls().length > 0);
    expect(stalls()[0]!.parentSpanContext?.spanId).toBe(jobRoot.spanContext().spanId);
    jobRoot.end();
  });
});

describe('BlockedSpanTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('picks the innermost span current across the window and forgets ended ones', () => {
    vi.useFakeTimers();
    const T = 1_000_000;
    vi.setSystemTime(T);
    const tracker = new BlockedSpanTracker({ retention: 60_000 });
    const provider = new NodeTracerProvider({ spanProcessors: [tracker] });
    const t = provider.getTracer('test');
    const outer = t.startSpan('outer');
    const inner = t.startSpan('inner');
    const early = t.startSpan('early');
    const late = t.startSpan('late');
    vi.setSystemTime(T + 40);
    early.end(); // over before the window opens
    vi.setSystemTime(T + 90);
    late.end(); // ended after the window closed: it was current during it
    vi.setSystemTime(T + 100);
    // the window: [T+50, T+80]. Open spans and `late` were current; the innermost is the one
    // created last, `late`; excluding it, `inner`
    expect(tracker.blockedSpan(T + 50, T + 80, new Set())).toBe(late);
    expect(tracker.blockedSpan(T + 50, T + 80, new Set(['late']))).toBe(inner);
    expect(tracker.blockedSpan(T + 50, T + 80, new Set(['late', 'inner']))).toBe(outer);
    expect(
      tracker.blockedSpan(T + 50, T + 80, new Set(['late', 'inner', 'outer'])),
    ).toBeUndefined();
    // a later window: only the spans still open qualify
    expect(tracker.blockedSpan(T + 95, T + 99, new Set())).toBe(inner);
    inner.end();
    outer.end();
    expect(tracker.openCount).toBe(0);
    // ended spans are forgotten after the retention
    vi.setSystemTime(T + 100 + 60_000 + 1);
    t.startSpan('tick').end();
    expect(tracker.blockedSpan(T + 50, T + 80, new Set())).toBeUndefined();
  });

  it('ignores a span created after the window, whatever its start time claims', () => {
    const tracker = new BlockedSpanTracker();
    const provider = new NodeTracerProvider({ spanProcessors: [tracker] });
    const t = provider.getTracer('test');
    const windowStart = Date.now() - 500;
    // back-dated like eou_wait: created now, starts in the past
    const backdated = t.startSpan('eou_wait', { startTime: windowStart - 1000 });
    expect(tracker.blockedSpan(windowStart, windowStart + 100, new Set())).toBeUndefined();
    backdated.end();
  });
});

describe.sequential('event loop stall stacks', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;
  let sessionRoot: ReturnType<typeof tracer.startSpan>;
  let monitors: EventLoopMonitor[];

  beforeEach(() => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    setTracerProvider(provider);
    sessionRoot = tracer.startSpan({ name: 'agent_session' });
    monitors = [];
  });

  afterEach(async () => {
    for (const monitor of monitors) monitor.stop();
    sessionRoot.end();
    setTracerProvider(originalProvider);
    await provider.shutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function startMonitor(stacks: 'adaptive' | 'always' | 'never'): {
    monitor: EventLoopMonitor;
    reports: BlockedReport[];
  } {
    const reports: BlockedReport[] = [];
    const monitor = new EventLoopMonitor({
      warnThreshold: WARN,
      errorThreshold: ERROR,
      tickInterval: TICK,
      stacks,
    });
    monitor.onReport = (report) => reports.push(report);
    const rootCtx = trace.setSpan(ROOT_CONTEXT, sessionRoot);
    monitor.setReportContext(rootCtx, (fn) =>
      runWithJobContext(fakeJob({ rootSpanContext: rootCtx }), fn),
    );
    monitor.start();
    monitors.push(monitor);
    return { monitor, reports };
  }

  function stalls() {
    return exporter.getFinishedSpans().filter((span) => span.name === SPAN_NAME);
  }

  /** The watchdog is up (it vouches for the process) and, if asked, sampling too. */
  async function watchdogReady(monitor: EventLoopMonitor, sampling: boolean): Promise<void> {
    await waitFor(() => monitor.watchdogActive);
    if (sampling) await waitFor(() => monitor.stackSamplingActive);
    // enabling the debugger domain blocks the loop for a moment: let that stall be reported
    await new Promise((resolve) => setTimeout(resolve, WARN + TICK * 4));
  }

  /** Reports of the loop's own code (a loaded host can add host stalls around a test's block). */
  function codeReports(reports: BlockedReport[]): BlockedReport[] {
    return reports.filter((report) => report.cause === 'code');
  }

  it('samples after the first stall by default, and names the blocking function', async () => {
    const { monitor, reports } = startMonitor('adaptive');
    await watchdogReady(monitor, false);
    expect(monitor.stackSamplingActive).toBe(false);

    burnCpuForTest(70);
    await waitFor(() => codeReports(reports).length >= 1);
    // the first stall turned sampling on but was itself reported without a stack
    expect(codeReports(reports)[0]!.stack).toBe(
      "# no sample: stack sampling starts after a process's first stall",
    );
    expect(codeReports(reports)[0]!.location).toBeUndefined();
    await watchdogReady(monitor, true);
    // enabling the debugger domain blocks the loop itself (see samplingStarted): with this
    // test's 30 ms threshold that is a stall of its own, and it is reported as such
    for (const report of codeReports(reports).slice(1)) {
      expect(report.stack).toContain('the stack sampler was starting');
    }
    const before = codeReports(reports).length;

    burnCpuForTest(80);
    await waitFor(() => codeReports(reports).length === before + 1);
    const report = codeReports(reports)[before]!;
    expect(report.stack).toMatch(/^# loop thread sampled \d+ms into the stall\n/);
    expect(report.stack).toContain('at burnCpuForTest (');
    expect(report.location).toMatch(/^burnCpuForTest \(.*loop_monitor_stacks\.test\.ts:\d+\)$/);
    expect(stalls().some((span) => span.attributes[ATTR_BLOCKING_STACK] === report.stack)).toBe(
      true,
    );
  });

  it('samples in the worker process too, into the log', async () => {
    // no spans and no job in the worker: the stack still names the blocking code in the log,
    // as the Python monitor's does in every process
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const reports: BlockedReport[] = [];
    const monitor = new EventLoopMonitor({
      warnThreshold: WARN,
      errorThreshold: ERROR,
      tickInterval: TICK,
      emitSpans: false,
      stacks: 'adaptive',
    });
    monitor.onReport = (report) => reports.push(report);
    monitor.start();
    monitors.push(monitor);
    await watchdogReady(monitor, false);

    burnCpuForTest(70);
    await waitFor(() => codeReports(reports).length >= 1);
    expect(codeReports(reports)[0]!.stack).toBe(
      "# no sample: stack sampling starts after a process's first stall",
    );
    await watchdogReady(monitor, true);
    const before = codeReports(reports).length;

    burnCpuForTest(80);
    await waitFor(() => codeReports(reports).length === before + 1);
    const report = codeReports(reports)[before]!;
    expect(report.stack).toContain('at burnCpuForTest (');
    expect(stalls()).toEqual([]);
    const logged = warn.mock.calls.map((call) => call[0] as { stack?: string });
    expect(logged.some((fields) => fields.stack === report.stack)).toBe(true);
  });

  it('samples from the start with always, and never with never', async () => {
    const always = startMonitor('always');
    await watchdogReady(always.monitor, true);
    const before = codeReports(always.reports).length; // the debugger enabling may be one
    burnCpuForTest(80);
    await waitFor(() => codeReports(always.reports).length === before + 1);
    expect(codeReports(always.reports)[before]!.stack).toContain('at burnCpuForTest (');
    always.monitor.stop();

    exporter.reset();
    const never = startMonitor('never');
    await watchdogReady(never.monitor, false);
    burnCpuForTest(70);
    await waitFor(() => codeReports(never.reports).length >= 1);
    expect(never.monitor.stackSamplingActive).toBe(false);
    expect(codeReports(never.reports)[0]!.stack).toBeUndefined();
    expect(stalls().every((span) => span.attributes[ATTR_BLOCKING_STACK] === undefined)).toBe(true);
  });

  it('takes a second look at a long stall', async () => {
    const { monitor, reports } = startMonitor('always');
    await watchdogReady(monitor, true);
    const before = codeReports(reports).length;
    burnCpuForTest(WARN * 12); // past LATE_SAMPLE_FACTOR x the threshold
    await waitFor(() => codeReports(reports).length === before + 1);
    const stack = codeReports(reports)[before]!.stack!;
    const headers = stack.split('\n').filter((line) => line.startsWith('# loop thread sampled'));
    expect(headers).toHaveLength(2);
    const offsets = headers.map((line) => Number(/(\d+)ms/.exec(line)![1]));
    expect(offsets[0]).toBeLessThan(offsets[1]!);
    expect(offsets[1]).toBeGreaterThanOrEqual(WARN * 10 - TICK);
    expect(stack.split('\n---\n')).toHaveLength(2);
  });

  it('samples a native call in its caller once it returns', async () => {
    const { monitor, reports } = startMonitor('always');
    await watchdogReady(monitor, true);
    const before = codeReports(reports).length;
    // a synchronous child process: V8 services the pause only when the call returns, so the
    // sample is taken at the end of the stall, in the frame that made the call (Atomics.wait,
    // by contrast, checks for interrupts and is sampled while waiting)
    execSync('sleep 0.08');
    await waitFor(() => codeReports(reports).length === before + 1);
    const report = codeReports(reports)[before]!;
    const offset = Number(/sampled (\d+)ms/.exec(report.stack!)![1]);
    expect(offset).toBeGreaterThanOrEqual(75);
    expect(report.stack).toContain('loop_monitor_stacks.test.ts');
  });

  it('discards a pause that landed after the loop had moved on', () => {
    const { monitor } = startMonitor('adaptive');
    const report = monitor['buildReport'](100, { cpuTime: 5, gcTime: 0, watchdogGap: 0 });
    const late = { offset: 150, pausedAt: report.endedAt + 50, frames: [] };
    monitor['attachStack'](report, [late]);
    expect(report.stack).toContain('native call');
    expect(report.stack).toContain('50ms after the call returned');
    expect(report.location).toBeUndefined();
    // and with no sample at all while sampling is off, the note says when it starts
    const short = monitor['buildReport'](100, { cpuTime: 5, gcTime: 0, watchdogGap: 0 });
    monitor['attachStack'](short, undefined);
    expect(short.stack).toBe("# no sample: stack sampling starts after a process's first stall");
  });

  it('puts the location in the warning', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    const { monitor, reports } = startMonitor('always');
    await watchdogReady(monitor, true);
    const before = codeReports(reports).length;
    burnCpuForTest(80);
    await waitFor(() => codeReports(reports).length === before + 1);
    const call = warn.mock.calls.find((args) => String(args[1]).includes('at burnCpuForTest'));
    expect(call).toBeDefined();
    expect(String(call![1])).toMatch(/^event loop blocked at burnCpuForTest \(/);
    expect((call![0] as { location?: string }).location).toContain('burnCpuForTest');
    expect((call![0] as { stack?: string }).stack).toContain('at burnCpuForTest (');
  });

  it('reads env: adaptive by default, 1/always, 0/never', () => {
    expect(stackSamplingModeFromEnv({})).toBe('adaptive');
    expect(stackSamplingModeFromEnv({ [ENV_STACKS]: '1' })).toBe('always');
    expect(stackSamplingModeFromEnv({ [ENV_STACKS]: 'always' })).toBe('always');
    expect(stackSamplingModeFromEnv({ [ENV_STACKS]: '0' })).toBe('never');
    expect(stackSamplingModeFromEnv({ [ENV_STACKS]: 'never' })).toBe('never');
    expect(stackSamplingModeFromEnv({ [ENV_STACKS]: 'sometimes' })).toBe('adaptive');
  });
});

describe('stack formatting', () => {
  const frame = (functionName: string, url: string, line = 1) => ({
    functionName,
    url,
    line,
    column: 1,
  });
  const sample = (offset: number, frames: StackSample['frames']): StackSample => ({
    offset,
    pausedAt: 0,
    frames,
  });

  it('formats like the Python monitor and cuts internals and the job runner', () => {
    const text = formatSample(
      sample(42.4, [
        frame('slowTool', 'file:///app/tools.js', 12),
        frame('processTimers', 'node:internal/timers', 500),
        frame('runEntry', 'file:///app/node_modules/@livekit/agents/dist/voice/x.js', 1),
        frame(
          'startJob',
          'file:///app/node_modules/@livekit/agents/dist/ipc/job_proc_lazy_main.js',
          7,
        ),
        frame('bootstrap', 'node:internal/main', 1),
      ]),
    );
    expect(text.split('\n')[0]).toBe('# loop thread sampled 42ms into the stall');
    expect(text).toContain('at slowTool (/app/tools.js:12:1)');
    expect(text).not.toContain('processTimers');
    expect(text).not.toContain('startJob');
    expect(text).not.toContain('bootstrap');
    expect(text).toContain('runEntry');
    // the innermost frame is kept even when it is Node's own
    expect(formatSample(sample(0, [frame('wait', '', 0)]))).toContain('at wait (native)');
    expect(formatSample(sample(0, [frame('read', 'node:fs', 3)]))).toContain(
      'at read (node:fs:3:1)',
    );
    // and the frame budget is the innermost 20
    const deep = sample(
      0,
      Array.from({ length: 30 }, (_, i) => frame(`f${i}`, 'file:///x.js', i)),
    );
    const lines = formatSample(deep).split('\n').slice(1);
    expect(lines).toHaveLength(MAX_STACK_FRAMES);
    expect(lines[0]).toContain('f0');
  });

  it('names the innermost frame of the agent’s own code', () => {
    expect(
      innermostLocation(
        sample(0, [
          frame('wait', '', 0),
          frame(
            'recordException',
            'file:///app/node_modules/@livekit/agents/dist/telemetry/utils.js',
            3,
          ),
          frame('myTool', 'file:///app/src/agent.ts', 42),
        ]),
      ),
    ).toBe('myTool (/app/src/agent.ts:42)');
    expect(innermostLocation(sample(0, [frame('wait', '', 0)]))).toBe('wait (native)');
    expect(innermostLocation(sample(0, []))).toBeUndefined();
  });
});
