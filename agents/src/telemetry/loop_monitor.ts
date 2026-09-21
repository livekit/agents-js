// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type Attributes,
  type Context,
  SpanStatusCode,
  context as otelContext,
} from '@opentelemetry/api';
import { url as inspectorUrl } from 'node:inspector';
import { PerformanceObserver } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { getJobContext } from '../job.js';
import { log } from '../log.js';
import { blockedSpanTracker } from './blocked_span_tracker.js';
import {
  LATE_SAMPLE_FACTOR,
  type StackSample,
  WATCHDOG_SOURCE,
  WD_LAST_WAKE,
  WD_LATE_AT,
  WD_LATE_GAP,
  WD_MAIN_LAST_TICK,
  WD_SLOTS,
  type WatchdogMessage,
  formatSample,
  innermostLocation,
  stackSamplingModeFromEnv,
} from './loop_stack_sampler.js';
import { recordEventLoopBlocked } from './otel_metrics.js';
import { RateLimiter } from './rate_limiter.js';
import { jobRootContext, recordLoopStall, sessionRootContext } from './session_context.js';
import {
  ATTR_BLOCKING_CAUSE,
  ATTR_BLOCKING_CPU_TIME,
  ATTR_BLOCKING_DURATION,
  ATTR_BLOCKING_GC_TIME,
  ATTR_BLOCKING_SEVERITY,
  ATTR_BLOCKING_STACK,
  ATTR_BLOCKING_SUPPRESSED,
  ATTR_BLOCKING_THRESHOLD,
} from './trace_types.js';
import { tracer } from './traces.js';

export const DEFAULT_WARN_THRESHOLD = 100;
export const DEFAULT_ERROR_THRESHOLD = 500;
export const DEFAULT_TICK_INTERVAL = 20;
const TICKS_PER_WARN_THRESHOLD = 5;
const MIN_TICK_INTERVAL = 20;
const MAX_TICK_INTERVAL = 50;

export const ENV_WARN_THRESHOLD_MS = 'LIVEKIT_AGENTS_LOOP_BLOCK_WARN_MS';
export const ENV_ERROR_THRESHOLD_MS = 'LIVEKIT_AGENTS_LOOP_BLOCK_ERROR_MS';
export const MAX_SPANS_PER_MINUTE = 6;
export const MAX_LOGS_PER_MINUTE = 5;
export const SPAN_NAME = 'event_loop_blocked';
/** Spans a stall must not nest under: itself, from an earlier heartbeat. */
const STALL_PARENT_EXCLUDES: ReadonlySet<string> = new Set([SPAN_NAME]);

export type LoopMonitorSeverity = 'warning' | 'error';

/**
 * What kept the loop from running: `code` is synchronous work on the loop thread, `host` is the
 * whole process not being scheduled (CPU contention on the host, a container CPU quota).
 */
export type LoopStallCause = 'code' | 'host';

/** What a report's `cpuTime` covers: the event-loop thread, or the whole process on older Node. */
export type LoopCpuScope = 'thread' | 'process';

/**
 * When the loop thread's stack is sampled (see loop_stack_sampler): `adaptive` from the
 * process's first code-caused stall on (a healthy process never enables the debugger domain),
 * `always` from the start, `never` not at all.
 */
export type StackSamplingMode = 'adaptive' | 'always' | 'never';

export interface BlockedReport {
  /** Heartbeat lag in milliseconds. */
  duration: number;
  /** Approximate wall-clock start in milliseconds since the Unix epoch. */
  startedAt: number;
  /** The last on-time heartbeat before the block, epoch ms: the block began within one tick after it. */
  windowStart: number;
  /** When the loop ran again (the late heartbeat), epoch ms. */
  endedAt: number;
  warnThreshold: number;
  severity: LoopMonitorSeverity;
  /**
   * Garbage-collection pause time observed during the stall, in milliseconds. Node delivers GC
   * entries to observers a couple of loop turns after the fact, so a report is emitted one
   * heartbeat after its stall to include them.
   */
  gcTime: number;
  /**
   * CPU consumed during the stall, in milliseconds. Scoped to the event-loop thread where Node
   * offers `process.threadCpuUsage()` (22.15 / 23.9 and later); process-wide before that, which
   * also counts the libuv pool and the native media threads and can exceed the stall duration.
   */
  cpuTime: number;
  /** What `cpuTime` covers. */
  cpuScope: LoopCpuScope;
  /** How late the watchdog thread woke during the stall, in milliseconds. 0 without a watchdog. */
  watchdogGap: number;
  /**
   * `host` when the whole process stopped running (host CPU contention, a container CPU quota, a
   * suspended machine) rather than code blocking the loop. Without a watchdog every stall is
   * attributed to `code`.
   */
  cause: LoopStallCause;
  /**
   * Sampled stacks of the loop thread during the stall, formatted like the Python monitor's:
   * one block per sample (`# loop thread sampled Nms into the stall` then the innermost frames),
   * blocks joined by `\n---\n`; or a one-line note saying why there is none. Absent for
   * host-caused stalls and when sampling is off.
   */
  stack?: string;
  /** The innermost frame of the agent's own code in the last sample, for the log line. */
  location?: string;
}

export class LoopMonitorThresholds {
  constructor(
    readonly warn: number,
    readonly error: number,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LoopMonitorThresholds | undefined {
    const warn = envMilliseconds(env, ENV_WARN_THRESHOLD_MS, DEFAULT_WARN_THRESHOLD);
    let error = envMilliseconds(env, ENV_ERROR_THRESHOLD_MS, DEFAULT_ERROR_THRESHOLD);
    if (warn <= 0) return undefined;
    if (error < warn) {
      log().warn(
        { errorThreshold: error, warnThreshold: warn },
        `${ENV_ERROR_THRESHOLD_MS} is below ${ENV_WARN_THRESHOLD_MS}; using the warn threshold for both`,
      );
      error = warn;
    }
    return new LoopMonitorThresholds(warn, error);
  }
}

function envMilliseconds(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    log().warn(
      { value: raw },
      `invalid ${name}, expected a finite number >= 0; using ${defaultValue}ms`,
    );
    return defaultValue;
  }
  return value;
}

export interface EventLoopMonitorOptions {
  warnThreshold?: number;
  errorThreshold?: number;
  tickInterval?: number;
  name?: string;
  emitSpans?: boolean;
  /**
   * Run a watchdog worker thread whose own late wake-ups reveal when the whole process was not
   * scheduled, so host contention is reported as such. Without it every stall is attributed to
   * code on the loop. Default true.
   */
  watchdog?: boolean;
  /**
   * When to sample the loop thread's stack with V8's profiler (see `loop_stack_sampler`):
   * `adaptive` (default) after the process's first code-caused stall, `always` from the start,
   * `never` not at all. Only job processes sample (spans enabled); the worker never does.
   */
  stacks?: StackSamplingMode;
}

export type ReportContextRunner = <T>(fn: () => T) => T;

// Per-thread CPU accounting (Node 22.15 / 23.9+). Older runtimes fall back to the process total.
const threadCpuUsage: (() => NodeJS.CpuUsage) | undefined = (
  process as { threadCpuUsage?: () => NodeJS.CpuUsage }
).threadCpuUsage?.bind(process);

/** Detect synchronous work that prevents the Node event loop from servicing timers. */
export class EventLoopMonitor {
  readonly warnThreshold: number;
  readonly errorThreshold: number;
  readonly tickInterval: number;
  readonly #name: string;
  readonly #emitSpans: boolean;
  readonly #useWatchdog: boolean;
  readonly #stackMode: StackSamplingMode;
  #samplingRequested = false;
  #samplingActive = false;
  /** When the watchdog enabled the debugger domain (epoch ms): a stall overlapping it is that. */
  #samplingStarted?: [number, number];
  /** Stack samples the watchdog posted, by the stall's window start, until the report is emitted. */
  readonly #samples = new Map<number, StackSample[]>();
  #lastTickWall = 0;
  readonly #spanLimiter = new RateLimiter(MAX_SPANS_PER_MINUTE);
  readonly #logLimiter = new RateLimiter(MAX_LOGS_PER_MINUTE);
  readonly #hostLogLimiter = new RateLimiter(MAX_LOGS_PER_MINUTE);
  #timer?: NodeJS.Timeout;
  #started = false;
  #closed = false;
  #lastTickAt = 0;
  #lastCpuUsage: NodeJS.CpuUsage = { user: 0, system: 0 };
  #gcObserver?: PerformanceObserver;
  #gcTime = 0;
  /** A stall detected on the previous tick, held back one heartbeat for its GC entries. */
  #pending?: BlockedReport;
  private cpuScope: LoopCpuScope = threadCpuUsage ? 'thread' : 'process';
  #watchdog?: Worker;
  #watchdogState?: BigInt64Array;
  #reportContext?: Context;
  #reportContextRunner?: ReportContextRunner;

  /** Observe every report that produced a span or a log, without going through OpenTelemetry. */
  onReport?: (report: BlockedReport) => void;

  constructor(options: EventLoopMonitorOptions = {}) {
    this.warnThreshold = options.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
    this.errorThreshold = options.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;
    this.tickInterval = options.tickInterval ?? DEFAULT_TICK_INTERVAL;
    this.#name = options.name ?? 'event-loop';
    this.#emitSpans = options.emitSpans ?? true;
    this.#useWatchdog = options.watchdog ?? true;
    this.#stackMode = options.stacks ?? stackSamplingModeFromEnv();
    if (!Number.isFinite(this.warnThreshold) || this.warnThreshold <= 0) {
      throw new Error('warnThreshold must be finite and > 0');
    }
    if (!Number.isFinite(this.errorThreshold) || this.errorThreshold < this.warnThreshold) {
      throw new Error('errorThreshold must be finite and >= warnThreshold');
    }
    if (
      !Number.isFinite(this.tickInterval) ||
      this.tickInterval <= 0 ||
      this.tickInterval > this.warnThreshold
    ) {
      throw new Error('tickInterval must be finite, > 0, and <= warnThreshold');
    }
  }

  /** Whether the watchdog thread is running, i.e. host contention can be told apart from code. */
  get watchdogActive(): boolean {
    return this.#watchdogState !== undefined;
  }

  /** Whether the stack sampler is running, i.e. the next stall will carry a stack. */
  get stackSamplingActive(): boolean {
    return this.#samplingActive;
  }

  /** Set the OTel parent and, optionally, a runner that restores job AsyncLocalStorage. */
  setReportContext(context: Context | undefined, runner?: ReportContextRunner): void {
    this.#reportContext = context;
    this.#reportContextRunner = runner;
  }

  /** Start the heartbeat. Idempotent. */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#lastTickAt = performance.now();
    this.#lastTickWall = Date.now();
    this.#lastCpuUsage = this.#cpuUsage();
    this.#startGcObserver();
    if (this.#stackMode === 'always') this.#samplingRequested = true;
    if (this.#useWatchdog) this.#startWatchdog();
    this.#scheduleTick();
  }

  /**
   * Have the watchdog sample the loop thread's stack from now on (see loop_stack_sampler). Not
   * while a debugger is attached to the process: our pauses would land in its session too.
   */
  #requestSampling(): void {
    if (this.#samplingRequested || this.#closed) return;
    if (inspectorUrl() !== undefined) {
      log().debug('event loop stack sampling left off: an inspector is attached to the process');
      return;
    }
    this.#samplingRequested = true;
    this.#watchdog?.postMessage({ type: 'enable_sampling' });
  }

  /** Stop the heartbeat and the watchdog. Idempotent. */
  stop(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    // a stall waiting for its GC entries must not be lost to the shutdown that follows
    this.#flushPending(this.#gcTime);
    this.#gcTime = 0;
    this.#gcObserver?.disconnect();
    this.#gcObserver = undefined;
    const watchdog = this.#watchdog;
    this.#watchdog = undefined;
    this.#watchdogState = undefined;
    void watchdog?.terminate().catch(() => undefined);
    this.#samplingActive = false;
    this.#samples.clear();
  }

  #startGcObserver(): void {
    try {
      this.#gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.#gcTime += entry.duration;
      });
      this.#gcObserver.observe({ entryTypes: ['gc'] });
    } catch (error) {
      this.#gcObserver = undefined;
      log().debug({ error }, 'event loop monitor cannot observe garbage collection');
    }
  }

  #startWatchdog(): void {
    const shared = new SharedArrayBuffer(WD_SLOTS * BigInt64Array.BYTES_PER_ELEMENT);
    const state = new BigInt64Array(shared);
    Atomics.store(state, WD_MAIN_LAST_TICK, BigInt(this.#lastTickWall));
    if (this.#samplingRequested && inspectorUrl() !== undefined) {
      log().debug('event loop stack sampling left off: an inspector is attached to the process');
      this.#samplingRequested = false;
    }
    try {
      const watchdog = new Worker(WATCHDOG_SOURCE, {
        eval: true,
        name: `livekit-loop-monitor-${this.#name}`,
        workerData: {
          shared,
          interval: this.tickInterval,
          warnThreshold: this.warnThreshold,
          lateFactor: LATE_SAMPLE_FACTOR,
          samplingEnabled: this.#samplingRequested,
        },
      });
      // the watchdog must not keep the process alive, nor take it down
      watchdog.unref();
      watchdog.on('error', (error) => {
        log().debug({ error }, 'event loop watchdog failed');
        this.#dropWatchdog(watchdog);
      });
      watchdog.on('exit', () => this.#dropWatchdog(watchdog));
      watchdog.on('message', (message: WatchdogMessage) => this.#onWatchdogMessage(message));
      this.#watchdog = watchdog;
      this.#watchdogState = state;
    } catch (error) {
      log().debug({ error }, 'event loop watchdog could not start');
    }
  }

  #onWatchdogMessage(message: WatchdogMessage): void {
    switch (message.type) {
      case 'sampling_started':
        this.#samplingActive = true;
        this.#samplingStarted = [message.from, message.to];
        log().debug(
          { enableDuration: message.to - message.from },
          'event loop stack sampling started',
        );
        break;
      case 'sampling_unavailable':
        this.#samplingRequested = false;
        log().debug({ reason: message.reason }, 'event loop stack sampling unavailable');
        break;
      case 'stall_sample': {
        const samples = this.#samples.get(message.windowStart) ?? [];
        samples.push(message.sample);
        this.#samples.set(message.windowStart, samples);
        // a stall whose report never came (the monitor stopped) must not pin its samples
        for (const key of this.#samples.keys()) {
          if (key < message.windowStart - 60_000) this.#samples.delete(key);
        }
        break;
      }
    }
  }

  #dropWatchdog(watchdog: Worker): void {
    if (this.#watchdog !== watchdog) return;
    this.#watchdog = undefined;
    this.#watchdogState = undefined;
    this.#samplingActive = false;
  }

  #scheduleTick(): void {
    this.#timer = setTimeout(() => this.#onTick(), this.tickInterval);
    this.#timer.unref();
  }

  #cpuUsage(): NodeJS.CpuUsage {
    return this.cpuScope === 'thread' && threadCpuUsage ? threadCpuUsage() : process.cpuUsage();
  }

  #onTick(): void {
    if (this.#closed) return;
    const now = performance.now();
    const lag = now - (this.#lastTickAt + this.tickInterval);
    const cpu = this.#cpuUsage();
    const cpuTime =
      (cpu.user - this.#lastCpuUsage.user + cpu.system - this.#lastCpuUsage.system) / 1000;
    const gcTime = this.#gcTime;
    this.#gcTime = 0;
    // the window opens at the last on-time tick, on the wall clock the watchdog shares
    const nowWall = Date.now();
    const windowStart = this.#lastTickWall;
    this.#lastTickAt = now;
    this.#lastTickWall = nowWall;
    this.#lastCpuUsage = cpu;
    const state = this.#watchdogState;
    if (state) Atomics.store(state, WD_MAIN_LAST_TICK, BigInt(nowWall));
    const watchdogGap = this.#consumeWatchdogGap(windowStart);
    this.#scheduleTick();
    // GC entries for the previous stall reach the observer through two immediates, which the
    // late tick can run ahead of; they have landed by now, so the previous stall gets them
    const gcClaimed = this.#flushPending(gcTime);
    if (lag < this.warnThreshold) return;
    this.#pending = this.buildReport(
      lag,
      { cpuTime, gcTime: gcClaimed ? 0 : gcTime, watchdogGap },
      { start: windowStart, end: nowWall },
    );
  }

  /** Emit the stall held from the previous tick, crediting it the GC time seen since. */
  #flushPending(gcTime: number): boolean {
    const pending = this.#pending;
    if (!pending) return false;
    this.#pending = undefined;
    pending.gcTime = Math.min(pending.gcTime + gcTime, pending.duration);
    // the watchdog's samples for this stall arrived on the message port between the two ticks
    const samples = this.#samples.get(pending.windowStart);
    this.#samples.delete(pending.windowStart);
    if (pending.cause === 'code') this.attachStack(pending, samples);
    this.report(pending);
    return true;
  }

  /**
   * How long the watchdog thread was kept from running during this tick's window.
   *
   * Two sources, since the two threads race when a descheduled process resumes: the watchdog's
   * recorded late wake-up if it fell inside the window (an older one belongs to a stall already
   * reported), and the time since its last run if it has not run since before the window opened.
   */
  #consumeWatchdogGap(windowStart: number): number {
    const state = this.#watchdogState;
    if (!state) return 0;
    const lastWake = Number(Atomics.load(state, WD_LAST_WAKE));
    const lateAt = Number(Atomics.exchange(state, WD_LATE_AT, 0n));
    const lateGap = Number(Atomics.exchange(state, WD_LATE_GAP, 0n));
    if (lastWake === 0) return 0; // the watchdog has not woken yet (it was just started)
    let gap = 0;
    if (lateAt >= windowStart) gap = lateGap;
    if (lastWake < windowStart) gap = Math.max(gap, Date.now() - lastWake - this.tickInterval);
    return Math.max(gap, 0);
  }

  private buildReport(
    lag: number,
    timings: { cpuTime: number; gcTime: number; watchdogGap: number },
    window?: { start: number; end: number },
  ): BlockedReport {
    const endedAt = window?.end ?? Date.now();
    // the watchdog is an independent thread: if it too woke late by most of the stall, the
    // process was not being scheduled (host contention, CPU quota, a suspended machine). Under
    // contention the scheduler can also starve only the watchdog while the loop thread runs
    // synchronous code, which is still code's fault: the loop thread's own CPU time tells, since
    // a thread that was not running burns none. Process-wide CPU cannot say which thread was
    // busy, so without per-thread accounting the watchdog alone decides.
    const watchdogStarved = timings.watchdogGap >= lag * 0.5;
    const loopThreadBusy = this.cpuScope === 'thread' && timings.cpuTime >= lag * 0.5;
    const processDescheduled = watchdogStarved && !loopThreadBusy;
    return {
      duration: lag,
      // the block started no earlier than the last on-time tick
      startedAt: endedAt - lag,
      windowStart: window?.start ?? endedAt - lag - this.tickInterval,
      endedAt,
      warnThreshold: this.warnThreshold,
      // severity measures the impact on the session, whatever the cause: audio and turn handling
      // were delayed either way. The cause says who can fix it.
      severity: lag >= this.errorThreshold ? 'error' : 'warning',
      gcTime: Math.min(timings.gcTime, lag),
      cpuTime: timings.cpuTime,
      cpuScope: this.cpuScope,
      watchdogGap: timings.watchdogGap,
      cause: processDescheduled ? 'host' : 'code',
    };
  }

  private report(report: BlockedReport): void {
    const now = performance.now();
    // host contention and blocking code are fixed by different people: each has its own log
    // quota so a noisy neighbor cannot silence a report about the agent's code, or the reverse
    const emitLog =
      report.cause === 'host' ? this.#hostLogLimiter.allow(now) : this.#logLimiter.allow(now);
    const emit = () => {
      // the metric and the session summary count every stall, including the ones the span and
      // log limiters drop
      try {
        recordEventLoopBlocked(report.duration / 1000, report.severity, report.cause);
      } catch (error) {
        log().error({ error }, 'failed to record the blocked event loop metric');
      }
      recordLoopStall(report.duration / 1000, report.startedAt + report.duration, report.cause);
      // a span needs a job to belong to (a root span here would be a stray trace), so the span
      // quota is only charged once the job context is restored and a span can exist: stalls of
      // an idle child before its job, or of the worker process, must not use up the job's budget
      const spanEligible = this.#emitSpans && getJobContext(false) !== undefined;
      const emitSpan = spanEligible && this.#spanLimiter.allow(now);
      // a code stall turns sampling on for the stalls that follow (adaptive), in every process:
      // the worker's and an idle child's stalls are logged, and a log with a stack names the
      // blocking code just as a span does. This one is reported without a stack, like the
      // Python monitor's unsampled stalls
      if (report.cause === 'code' && this.#stackMode === 'adaptive') {
        this.#requestSampling();
      }
      if (!emitSpan && !emitLog) return;
      if (emitSpan) this.#emitSpan(report, this.#spanLimiter.takeSuppressed());
      if (emitLog) this.#emitLog(report);
      this.onReport?.(report);
    };

    try {
      const run = () =>
        this.#reportContext ? otelContext.with(this.#reportContext, emit) : emit();
      this.#reportContextRunner ? this.#reportContextRunner(run) : run();
    } catch (error) {
      log().error({ error }, 'failed to report a blocked event loop');
    }
  }

  /**
   * Set `stack` and `location` from the watchdog's samples of this stall, or a note saying why
   * there are none, worded like the Python monitor's.
   */
  private attachStack(report: BlockedReport, samples: StackSample[] | undefined): void {
    const started = this.#samplingStarted;
    if (started && started[0] <= report.endedAt && started[1] >= report.windowStart) {
      // enabling the debugger domain enumerates every loaded script on the loop: this stall is
      // that, whatever the pause then saw
      report.stack =
        '# no sample: the stack sampler was starting (enabling the debugger domain blocks the loop for the size of the loaded code)';
      return;
    }
    // a pause that landed after the loop ran again saw whatever ran next, not the block
    const inStall = (samples ?? []).filter((sample) => sample.pausedAt <= report.endedAt + 2);
    if (inStall.length) {
      report.stack = inStall.map(formatSample).join('\n---\n');
      report.location = innermostLocation(inStall[inStall.length - 1]!);
      return;
    }
    if (this.#stackMode === 'never') return;
    if (samples?.length) {
      const late = Math.max(samples[0]!.pausedAt - report.endedAt, 0);
      report.stack =
        '# no sample: the loop thread was in a native call for the whole stall, which the ' +
        `pause could not interrupt (it landed ${late.toFixed(0)}ms after the call returned)`;
      return;
    }
    report.stack = this.#samplingActive
      ? '# no sample: the block ended before the watchdog looked'
      : "# no sample: stack sampling starts after a process's first stall";
  }

  #emitSpan(report: BlockedReport, suppressed: number): void {
    const attributes: Attributes = {
      [ATTR_BLOCKING_DURATION]: report.duration / 1000,
      [ATTR_BLOCKING_THRESHOLD]: report.warnThreshold / 1000,
      [ATTR_BLOCKING_SEVERITY]: report.severity,
      [ATTR_BLOCKING_CAUSE]: report.cause,
      [ATTR_BLOCKING_GC_TIME]: report.gcTime / 1000,
      [ATTR_BLOCKING_CPU_TIME]: report.cpuTime / 1000,
    };
    if (suppressed) attributes[ATTR_BLOCKING_SUPPRESSED] = suppressed;
    if (report.stack) attributes[ATTR_BLOCKING_STACK] = report.stack;
    // under the span that was blocked (see BlockedSpanTracker), else the session root, else the
    // job's root: the heartbeat's own context predates all of them
    const fallback = sessionRootContext() ?? jobRootContext() ?? this.#reportContext;
    const blocked = blockedSpanTracker.blockedContext(
      report.startedAt,
      report.endedAt,
      STALL_PARENT_EXCLUDES,
      fallback ?? otelContext.active(),
      this.tickInterval,
    );
    const span = tracer.startSpan({
      name: SPAN_NAME,
      context: blocked ?? fallback,
      startTime: report.startedAt,
      attributes,
    });
    if (report.severity === 'error') {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message:
          report.cause === 'host'
            ? `process not scheduled for ${report.duration.toFixed(0)}ms`
            : `event loop blocked for ${report.duration.toFixed(0)}ms`,
      });
    }
    span.end(report.startedAt + report.duration);
  }

  #emitLog(report: BlockedReport): void {
    const round = (value: number) => Math.round(value * 10) / 10;
    const fields = {
      duration: round(report.duration),
      threshold: report.warnThreshold,
      gcTime: round(report.gcTime),
      cpuTime: round(report.cpuTime),
      cpuScope: report.cpuScope,
      watchdogGap: round(report.watchdogGap),
      cause: report.cause,
      loop: this.#name,
      ...(report.location ? { location: report.location } : {}),
      ...(report.stack ? { stack: report.stack } : {}),
    };
    if (report.cause === 'host') {
      log().warn(
        fields,
        'process not scheduled; the host did not run the agent for the whole stall (CPU contention or a container CPU quota), which delays audio and turn handling like blocking code would. Check the CPU limit and co-located load',
      );
    } else if (this.watchdogActive) {
      const where = report.location ? ` at ${report.location}` : '';
      log().warn(
        fields,
        `event loop blocked${where}; synchronous work on the agent loop delays audio and turn handling, move it to a worker thread or an async API`,
      );
    } else {
      // without the watchdog a stall could as well be the host not scheduling the process
      const where = report.location ? ` at ${report.location}` : '';
      log().warn(
        fields,
        `event loop stalled${where}; either synchronous work on the agent loop (move it to a worker thread or an async API) or the host did not schedule the process (CPU contention or quota)`,
      );
    }
  }
}

function tickIntervalFor(warnThreshold: number): number {
  return Math.min(
    Math.max(warnThreshold / TICKS_PER_WARN_THRESHOLD, MIN_TICK_INTERVAL),
    MAX_TICK_INTERVAL,
  );
}

interface MonitorGlobalState {
  monitor?: EventLoopMonitor;
}

const MONITOR_KEY = Symbol.for('@livekit/agents:eventLoopMonitor');
const globals = globalThis as typeof globalThis & { [MONITOR_KEY]?: MonitorGlobalState };
const monitorState = (globals[MONITOR_KEY] ??= {});

export interface StartMonitoringOptions {
  thresholds?: LoopMonitorThresholds;
  name?: string;
  emitSpans?: boolean;
  watchdog?: boolean;
  stacks?: StackSamplingMode;
}

/** Start the process event-loop monitor, or return undefined if disabled/already running. */
export function startMonitoring(
  options: StartMonitoringOptions = {},
): EventLoopMonitor | undefined {
  let thresholds = options.thresholds ?? LoopMonitorThresholds.fromEnv();
  if (!thresholds || monitorState.monitor) return undefined;
  if (thresholds.warn < MIN_TICK_INTERVAL) {
    log().warn(
      { warnThreshold: thresholds.warn },
      'loop monitor warn threshold raised to 20ms, the smallest it measures',
    );
    thresholds = new LoopMonitorThresholds(
      MIN_TICK_INTERVAL,
      Math.max(thresholds.error, MIN_TICK_INTERVAL),
    );
  }
  const monitor = new EventLoopMonitor({
    warnThreshold: thresholds.warn,
    errorThreshold: thresholds.error,
    tickInterval: tickIntervalFor(thresholds.warn),
    name: options.name,
    emitSpans: options.emitSpans,
    watchdog: options.watchdog,
    stacks: options.stacks,
  });
  monitorState.monitor = monitor;
  monitor.start();
  return monitor;
}

export function stopMonitoring(monitor?: EventLoopMonitor): void {
  if (monitor && monitorState.monitor !== monitor) return;
  monitorState.monitor?.stop();
  monitorState.monitor = undefined;
}

export function getMonitor(): EventLoopMonitor | undefined {
  return monitorState.monitor;
}
