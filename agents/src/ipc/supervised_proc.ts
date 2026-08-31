// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import pidusage from 'pidusage';
import { safeErrorType } from '../error_utils.js';
import type { RunningJobInfo } from '../job.js';
import { log, loggerOptions } from '../log.js';
import { Future } from '../utils.js';
import type { IPCMessage } from './message.js';

const MEMORY_MONITOR_INTERVAL = 5000;
const MEMORY_WARN_COOLDOWN = 120000;
const MEMORY_WARN_RESET_DELTA_MB = 50;
const SHUTDOWN_STAGE_GRACE = 5000;

export interface ProcOpts {
  /** Timeout for process initialization in milliseconds. */
  initializeTimeout: number;
  /** Timeout for process shutdown in milliseconds. */
  closeTimeout: number;
  /** Memory usage warning threshold in megabytes. */
  memoryWarnMB: number;
  /** Memory usage limit in megabytes. */
  memoryLimitMB: number;
  /** Interval for health check pings in milliseconds. */
  pingInterval: number;
  /** Timeout waiting for pong response in milliseconds. */
  pingTimeout: number;
  /** Threshold for warning about unresponsive processes in milliseconds. */
  highPingThreshold: number;
}

export abstract class SupervisedProc {
  #opts: ProcOpts;
  #started = false;
  #closing = false;
  #startedAt?: number;
  #runningJob?: RunningJobInfo = undefined;
  proc?: ChildProcess;
  #pingInterval?: ReturnType<typeof setInterval>;
  #memoryMonitorInterval?: ReturnType<typeof setInterval>;
  #pongTimeout?: ReturnType<typeof setTimeout>;
  private memoryBaselineMB?: number;
  #lastMemoryWarnAt = 0;
  #lastMemoryWarnMB = 0;
  protected init = new Future();
  #join = new Future();
  #shutdownRequestAck = new Future();
  #sessionEndStarted = new Future();
  #shuttingDown = new Future();
  #closePromise?: Promise<void>;
  #logger = log().child({ runningJob: this.#runningJob });

  constructor(
    initializeTimeout: number,
    closeTimeout: number,
    memoryWarnMB: number,
    memoryLimitMB: number,
    pingInterval: number,
    pingTimeout: number,
    highPingThreshold: number,
  ) {
    this.#opts = {
      initializeTimeout,
      closeTimeout,
      memoryWarnMB,
      memoryLimitMB,
      pingInterval,
      pingTimeout,
      highPingThreshold,
    };
  }

  abstract createProcess(): ChildProcess;
  abstract mainTask(child: ChildProcess): Promise<void>;
  protected abstract get processKind(): string;

  protected get stagedShutdown(): boolean {
    return false;
  }

  get started(): boolean {
    return this.#started;
  }

  get isAlive(): boolean {
    return this.#started && !this.#closing && !!this.proc?.connected;
  }

  get runningJob(): RunningJobInfo | undefined {
    return this.#runningJob;
  }

  async start() {
    if (this.#started) {
      throw new Error('runner already started');
    } else if (this.#closing) {
      throw new Error('runner is closed');
    }

    this.proc = this.createProcess();

    this.#started = true;
    this.#startedAt = performance.now();
    this.run().catch((error) => {
      this.#logger
        .child({ exceptionType: safeErrorType(error) })
        .warn('supervised process run failed');
      // Note: we intentionally do NOT kill the child process here. Killing it
      // would race with initialize()'s `once(proc, 'message')`, causing
      // initialize() to hang forever and deadlocking the caller (proc_pool).
      // The child process is cleaned up when the pool shuts down.
      this.#join.resolve();
    });
  }

  async run() {
    await this.init.await;

    this.#pingInterval = setInterval(() => {
      if (this.proc?.connected) {
        this.proc.send({ case: 'pingRequest', value: { timestamp: Date.now() } });
      }
    }, this.#opts.pingInterval);

    this.#pongTimeout = setTimeout(() => {
      this.#logger.warn('job is unresponsive');
      clearTimeout(this.#pongTimeout);
      clearInterval(this.#pingInterval);
      this.proc!.kill();
      this.#join.resolve();
    }, this.#opts.pingTimeout);

    this.#memoryMonitorInterval = setInterval(async () => {
      const memoryMB = await this.getChildMemoryUsageMB();
      if (memoryMB === 0) {
        return;
      }

      this.memoryBaselineMB ??= memoryMB;

      if (this.#opts.memoryLimitMB > 0 && memoryMB > this.#opts.memoryLimitMB) {
        this.#logger
          .child(this.memoryLoggingFields(memoryMB))
          .error(`${this.processKind} process exceeded memory limit, killing it`);
        this.close();
      } else if (this.#opts.memoryWarnMB > 0 && memoryMB > this.#opts.memoryWarnMB) {
        if (this.shouldEmitMemoryWarning(memoryMB)) {
          const advisory = this.#opts.memoryLimitMB <= 0;
          this.#logger
            .child(this.memoryLoggingFields(memoryMB))
            .warn(
              `${this.processKind} process memory usage is above the warning threshold${
                advisory ? ' (advisory only, the process will not be terminated)' : ''
              }`,
            );
        }
      }
    }, MEMORY_MONITOR_INTERVAL);

    const listener = (msg: IPCMessage) => {
      switch (msg.case) {
        case 'pongResponse': {
          const delay = Date.now() - msg.value.timestamp;
          if (delay > this.#opts.highPingThreshold) {
            this.#logger.child({ delay }).warn('job executor is unresponsive');
          }
          this.#pongTimeout?.refresh();
          break;
        }
        case 'exiting': {
          this.#logger.child({ reason: msg.value.reason }).debug('job exiting');
          break;
        }
        case 'shutdownRequestAck': {
          if (!this.#shutdownRequestAck.done) this.#shutdownRequestAck.resolve();
          break;
        }
        case 'sessionEndStarted': {
          if (!this.#sessionEndStarted.done) this.#sessionEndStarted.resolve();
          break;
        }
        case 'shuttingDown': {
          if (!this.#shuttingDown.done) this.#shuttingDown.resolve();
          break;
        }
        case 'done': {
          if (!this.#shutdownRequestAck.done) this.#shutdownRequestAck.resolve();
          if (!this.#sessionEndStarted.done) this.#sessionEndStarted.resolve();
          if (!this.#shuttingDown.done) this.#shuttingDown.resolve();
          this.#closing = true;
          this.proc!.off('message', listener);
          break;
        }
      }
    };
    this.proc!.on('message', listener);
    this.proc!.on('error', (error) => {
      if (this.#closing) return;
      this.#logger
        .child({ exceptionType: safeErrorType(error) })
        .warn('job process exited unexpectedly; this likely means the error above caused a crash');
      this.clearTimers();
      this.#join.resolve();
    });

    this.proc!.on('exit', () => {
      this.clearTimers();
      this.#join.resolve();
    });

    this.mainTask(this.proc!);

    await this.#join.await;
  }

  async join() {
    if (!this.#started) {
      throw new Error('runner not started');
    }

    await this.#join.await;
  }

  async initialize() {
    if (!this.proc?.connected) {
      const err = new Error('process not connected');
      this.init.reject(err);
      throw err;
    }
    this.proc.send({
      case: 'initializeRequest',
      value: {
        loggerOptions: loggerOptions(),
        pingInterval: this.#opts.pingInterval,
        pingTimeout: this.#opts.pingTimeout,
        highPingThreshold: this.#opts.highPingThreshold,
      },
    });

    // Race the first message against child exit and the timeout: a child that
    // crashes before sending initializeResponse would otherwise leave the
    // `once('message')` pending forever and hang the caller.
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('runner initialization timed out')),
        this.#opts.initializeTimeout,
      );
    });
    const onMessage = once(this.proc!, 'message', { signal: abort.signal }).then(
      ([msg]: IPCMessage[]) => {
        if (msg!.case !== 'initializeResponse') {
          throw new Error('first message must be InitializeResponse');
        }
      },
    );
    const onExit = once(this.proc!, 'exit', { signal: abort.signal }).then(([code, signal]) => {
      throw new Error(`process exited before initializing (code ${code}, signal ${signal})`);
    });

    try {
      await Promise.race([onMessage, onExit, timeout]);
      this.init.resolve();
    } catch (err) {
      this.init.reject(err as Error);
      // On timeout (or a bad first message) the child is still alive — kill it
      // so a failed initialize doesn't leak the process.
      if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
        this.proc.kill();
      }
      throw err;
    } finally {
      clearTimeout(timer);
      abort.abort();
      // Swallow the AbortError from whichever listener lost the race.
      onMessage.catch(() => {});
      onExit.catch(() => {});
    }
  }

  close(): Promise<void> {
    if (!this.#started) {
      return Promise.resolve();
    }
    this.#closePromise ??= this.closeOnce();
    return this.#closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.#closing = true;
    this.clearTimers();

    try {
      if (this.#join.done) return;

      if (!this.proc?.connected) {
        await this.waitForExit(this.#opts.closeTimeout);
        return;
      }

      this.proc.send({ case: 'shutdownRequest' });

      if (!this.stagedShutdown) {
        await this.waitForExit(this.#opts.closeTimeout);
        return;
      }

      if (
        !(await this.waitForShutdownStage(
          this.#shutdownRequestAck,
          this.#opts.closeTimeout,
          'job did not acknowledge shutdown in time',
        ))
      ) {
        return;
      }

      if (
        !(await this.waitForShutdownStage(
          this.#sessionEndStarted,
          this.#opts.closeTimeout + SHUTDOWN_STAGE_GRACE,
          'job did not begin session-end handling in time',
        ))
      ) {
        return;
      }

      if (!(await this.waitForShutdownCompletion(this.#shuttingDown))) {
        return;
      }

      await this.waitForExit(this.#opts.closeTimeout);
    } finally {
      this.clearTimers();
    }
  }

  private async waitForShutdownStage(
    stage: Future,
    timeout: number,
    timeoutMessage: string,
  ): Promise<boolean> {
    if (this.#join.done) return false;
    if (stage.done) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      stage.await.then(() => 'stage' as const),
      this.#join.await.then(() => 'exit' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeout);
      }),
    ]);
    clearTimeout(timer);

    if (result === 'timeout') {
      this.#logger.child({ timeout }).error(timeoutMessage);
      this.proc?.kill();
      await this.#join.await;
    }

    return result === 'stage';
  }

  private async waitForShutdownCompletion(stage: Future): Promise<boolean> {
    if (this.#join.done) return false;
    if (stage.done) return true;

    const result = await Promise.race([
      stage.await.then(() => 'stage' as const),
      this.#join.await.then(() => 'exit' as const),
    ]);
    return result === 'stage';
  }

  private async waitForExit(timeout: number): Promise<void> {
    if (this.#join.done) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.#join.await.then(() => 'exit' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeout);
      }),
    ]);
    clearTimeout(timer);

    if (result === 'timeout') {
      this.#logger.child({ timeout }).error('job shutdown is taking too much time');
      this.proc?.kill();
      await this.#join.await;
    }
  }

  async launchJob(info: RunningJobInfo) {
    if (this.#runningJob) {
      throw new Error('executor already has a running job');
    }
    if (!this.proc?.connected) {
      throw new Error('process not connected');
    }
    this.#runningJob = info;
    this.proc.send({ case: 'startJobRequest', value: { runningJob: info } });
  }

  private async getChildMemoryUsageMB(): Promise<number> {
    const pid = this.proc?.pid;
    if (!pid) {
      return 0;
    }
    try {
      const stats = await pidusage(pid);
      return stats.memory / (1024 * 1024);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') {
        return 0;
      }
      throw err;
    }
  }

  private get uptime(): number {
    if (this.#startedAt === undefined) {
      return 0;
    }
    return performance.now() - this.#startedAt;
  }

  private shouldEmitMemoryWarning(memoryMB: number, now: number = performance.now()): boolean {
    const cooledDown = now - this.#lastMemoryWarnAt >= MEMORY_WARN_COOLDOWN;
    const grew = memoryMB - this.#lastMemoryWarnMB >= MEMORY_WARN_RESET_DELTA_MB;
    if (cooledDown || grew) {
      this.#lastMemoryWarnAt = now;
      this.#lastMemoryWarnMB = memoryMB;
      return true;
    }
    return false;
  }

  private memoryLoggingFields(memoryMB: number): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      pid: this.proc?.pid,
      memoryUsageMB: Math.round(memoryMB * 10) / 10,
      memoryWarnMB: this.#opts.memoryWarnMB,
      memoryLimitMB: this.#opts.memoryLimitMB,
      uptime: this.uptime,
      hasRunningJob: this.runningJob !== undefined,
    };

    if (this.memoryBaselineMB !== undefined) {
      fields.baselineMemoryMB = Math.round(this.memoryBaselineMB * 10) / 10;
      fields.growthMemoryMB = Math.round((memoryMB - this.memoryBaselineMB) * 10) / 10;
    }

    return fields;
  }

  private clearTimers() {
    clearTimeout(this.#pongTimeout);
    clearInterval(this.#pingInterval);
    clearInterval(this.#memoryMonitorInterval);
  }
}
