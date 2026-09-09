// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type Attributes,
  type Context,
  SpanStatusCode,
  context as otelContext,
} from '@opentelemetry/api';
import { getJobContext } from '../job.js';
import { log } from '../log.js';
import { recordEventLoopBlocked } from './otel_metrics.js';
import { recordLoopStall, sessionRootContext } from './session_context.js';
import {
  ATTR_BLOCKING_CPU_TIME,
  ATTR_BLOCKING_DURATION,
  ATTR_BLOCKING_SEVERITY,
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
export const MAX_SPANS_PER_MINUTE = 30;
export const MAX_LOGS_PER_MINUTE = 5;
export const SPAN_NAME = 'event_loop_blocked';

export type LoopMonitorSeverity = 'warning' | 'error';

export interface BlockedReport {
  /** Heartbeat lag in milliseconds. */
  duration: number;
  /** Approximate wall-clock start in milliseconds since the Unix epoch. */
  startedAt: number;
  warnThreshold: number;
  severity: LoopMonitorSeverity;
  /** Process CPU consumed during the heartbeat interval, in milliseconds. */
  cpuTime: number;
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

/** @internal */
export class _RateLimiter {
  readonly #limit: number;
  readonly #events: number[] = [];
  #suppressed = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  allow(now: number): boolean {
    const windowStart = now - 60_000;
    while (this.#events.length && this.#events[0]! < windowStart) this.#events.shift();
    if (this.#events.length >= this.#limit) {
      this.#suppressed++;
      return false;
    }
    this.#events.push(now);
    return true;
  }

  takeSuppressed(): number {
    const suppressed = this.#suppressed;
    this.#suppressed = 0;
    return suppressed;
  }
}

export interface EventLoopMonitorOptions {
  warnThreshold?: number;
  errorThreshold?: number;
  tickInterval?: number;
  name?: string;
  emitSpans?: boolean;
}

export type ReportContextRunner = <T>(fn: () => T) => T;

/** Detect synchronous work that prevents the Node event loop from servicing timers. */
export class EventLoopMonitor {
  readonly warnThreshold: number;
  readonly errorThreshold: number;
  readonly tickInterval: number;
  readonly #name: string;
  readonly #emitSpans: boolean;
  readonly #spanLimiter = new _RateLimiter(MAX_SPANS_PER_MINUTE);
  readonly #logLimiter = new _RateLimiter(MAX_LOGS_PER_MINUTE);
  #timer?: NodeJS.Timeout;
  #started = false;
  #closed = false;
  #lastTickAt = 0;
  #lastCpuUsage: NodeJS.CpuUsage = { user: 0, system: 0 };
  #reportContext?: Context;
  #reportContextRunner?: ReportContextRunner;

  /** Tests and integrations may observe reports without going through OpenTelemetry. @internal */
  _onReport?: (report: BlockedReport) => void;

  constructor(options: EventLoopMonitorOptions = {}) {
    this.warnThreshold = options.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
    this.errorThreshold = options.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;
    this.tickInterval = options.tickInterval ?? DEFAULT_TICK_INTERVAL;
    this.#name = options.name ?? 'event-loop';
    this.#emitSpans = options.emitSpans ?? true;
    if (this.warnThreshold <= 0) throw new Error('warnThreshold must be > 0');
    if (this.errorThreshold < this.warnThreshold) {
      throw new Error('errorThreshold must be >= warnThreshold');
    }
    if (this.tickInterval <= 0 || this.tickInterval > this.warnThreshold) {
      throw new Error('tickInterval must be > 0 and <= warnThreshold');
    }
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
    this.#lastCpuUsage = process.cpuUsage();
    this.#scheduleTick();
  }

  /** Stop the heartbeat. Idempotent. */
  stop(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #scheduleTick(): void {
    this.#timer = setTimeout(() => this.#onTick(), this.tickInterval);
    this.#timer.unref();
  }

  #onTick(): void {
    if (this.#closed) return;
    const now = performance.now();
    const lag = now - (this.#lastTickAt + this.tickInterval);
    const cpu = process.cpuUsage();
    const cpuTime =
      (cpu.user - this.#lastCpuUsage.user + cpu.system - this.#lastCpuUsage.system) / 1000;
    this.#lastTickAt = now;
    this.#lastCpuUsage = cpu;
    this.#scheduleTick();
    if (lag < this.warnThreshold) return;
    this._report(this._buildReport(lag, cpuTime));
  }

  /** @internal */
  _buildReport(duration: number, cpuTime: number): BlockedReport {
    return {
      duration,
      startedAt: Date.now() - duration,
      warnThreshold: this.warnThreshold,
      severity: duration >= this.errorThreshold ? 'error' : 'warning',
      cpuTime,
    };
  }

  /** @internal */
  _report(report: BlockedReport): void {
    const now = performance.now();
    const emitSpan = this.#spanLimiter.allow(now);
    const emitLog = this.#logLimiter.allow(now);
    const emit = () => {
      try {
        recordEventLoopBlocked(report.duration / 1000, report.severity);
      } catch (error) {
        log().error({ error }, 'failed to record the blocked event loop metric');
      }
      recordLoopStall(report.duration / 1000, report.startedAt + report.duration);
      if (!emitSpan && !emitLog) return;
      if (emitSpan && this.#emitSpans) {
        this.#emitSpan(report, this.#spanLimiter.takeSuppressed());
      }
      if (emitLog) this.#emitLog(report);
      this._onReport?.(report);
    };

    try {
      const run = () =>
        this.#reportContext ? otelContext.with(this.#reportContext, emit) : emit();
      this.#reportContextRunner ? this.#reportContextRunner(run) : run();
    } catch (error) {
      log().error({ error }, 'failed to report a blocked event loop');
    }
  }

  #emitSpan(report: BlockedReport, suppressed: number): void {
    if (!getJobContext(false)) return;
    const attributes: Attributes = {
      [ATTR_BLOCKING_DURATION]: report.duration / 1000,
      [ATTR_BLOCKING_THRESHOLD]: report.warnThreshold / 1000,
      [ATTR_BLOCKING_SEVERITY]: report.severity,
      [ATTR_BLOCKING_CPU_TIME]: report.cpuTime / 1000,
    };
    if (suppressed) attributes[ATTR_BLOCKING_SUPPRESSED] = suppressed;
    const span = tracer.startSpan({
      name: SPAN_NAME,
      context: sessionRootContext() ?? this.#reportContext,
      startTime: report.startedAt,
      attributes,
    });
    if (report.severity === 'error') {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `event loop blocked for ${report.duration.toFixed(0)}ms`,
      });
    }
    span.end(report.startedAt + report.duration);
  }

  #emitLog(report: BlockedReport): void {
    log().warn(
      {
        duration: Math.round(report.duration * 10) / 10,
        threshold: report.warnThreshold,
        cpuTime: Math.round(report.cpuTime * 10) / 10,
        loop: this.#name,
      },
      'event loop blocked; synchronous work on the agent loop delays audio and turn handling, move it to a worker or an async client',
    );
  }
}

/** @internal */
export function _tickIntervalFor(warnThreshold: number): number {
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
    tickInterval: _tickIntervalFor(thresholds.warn),
    name: options.name,
    emitSpans: options.emitSpans,
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
