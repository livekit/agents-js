// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import pidusage from 'pidusage';
import type { RunningJobInfo } from '../job.js';
import { log, loggerOptions } from '../log.js';
import { Future } from '../utils.js';
import type { IPCMessage } from './message.js';

const MEMORY_MONITOR_INTERVAL = 5000;
const MEMORY_WARN_COOLDOWN = 120000;
const MEMORY_WARN_RESET_DELTA_MB = 50;

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
    this.run().catch((err) => {
      this.#logger.child({ err }).warn('supervised process run failed');
      // initialize() owns killing the child on its own failure paths, so we
      // don't need to kill it again here. Resolve #join so any pool caller
      // parked on join() unblocks promptly.
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
        case 'done': {
          this.#closing = true;
          this.proc!.off('message', listener);
          break;
        }
      }
    };
    this.proc!.on('message', listener);
    this.proc!.on('error', (err) => {
      if (this.#closing) return;
      this.#logger
        .child({ err })
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
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.init.reject(new Error('runner initialization timed out'));
      try {
        this.proc?.kill('SIGKILL');
      } catch {
        // proc may have already exited; the exit-race below will still settle.
      }
    }, this.#opts.initializeTimeout);
    if (!this.proc?.connected) {
      clearTimeout(timer);
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

    // Race three signals so initialize() always settles even when the warming
    // child dies/hangs without ever sending an IPC message:
    //   1. firstMessage  — happy path
    //   2. exited        — child crashed/exited before initializeResponse
    //   3. this.init     — the timeout above (or any other init rejection)
    // The losers of the race must pre-attach a `.catch` so the late
    // post-success `exit` does not surface as an unhandledRejection.
    const firstMessage = once(this.proc, 'message').then(([msg]: IPCMessage[]) => {
      if (msg!.case !== 'initializeResponse') {
        throw new Error('first message must be InitializeResponse');
      }
    });
    const exited = once(this.proc, 'exit').then(() => {
      throw new Error('process exited before initialization completed');
    });
    firstMessage.catch(() => {});
    exited.catch(() => {});

    try {
      await Promise.race([firstMessage, exited, this.init.await]);
    } catch (err) {
      if (!timedOut) {
        try {
          this.proc?.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
      this.init.reject(err as Error);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    this.init.resolve();
  }

  async close() {
    if (!this.#started) {
      return;
    }
    this.#closing = true;

    if (this.proc?.connected) {
      this.proc.send({ case: 'shutdownRequest' });
    }

    const timer = setTimeout(() => {
      this.#logger.error('job shutdown is taking too much time');
      this.proc!.kill();
    }, this.#opts.closeTimeout);
    await this.#join.await.then(() => {
      clearTimeout(timer);
      this.clearTimers();
    });
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
