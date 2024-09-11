// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { RunningJobInfo } from '../job.js';
import { Mutex } from '../utils.js';
import type { JobExecutor } from './job_executor.js';
import { ProcJobExecutor } from './proc_job_executor.js';

export class ProcPool {
  agent: string;
  numIdleProcesses: number;
  initializeTimeout: number;
  closeTimeout: number;
  executors: JobExecutor[] = [];
  tasks: Promise<void>[] = [];
  started = false;
  closed = false;
  controller = new AbortController();
  initMutex = new Mutex();
  procMutex = new Mutex(); // XXX(nbsp): wip, needs to support more than one
  procUnlock?: () => void;

  // equivalent to warmed_proc_queue
  warmedProcQueue: JobExecutor[] = [];
  warmedResolver?: (_: JobExecutor) => void;
  warmedEnqueue(item: JobExecutor) {
    if (this.warmedResolver) {
      this.warmedResolver(item);
      this.warmedResolver = undefined;
    } else {
      this.warmedProcQueue.push(item);
    }
  }
  async warmedDequeue(): Promise<JobExecutor> {
    if (this.warmedProcQueue.length > 0) {
      return this.warmedProcQueue.shift()!;
    } else {
      return new Promise<JobExecutor>((resolve) => {
        this.warmedResolver = resolve;
      });
    }
  }

  constructor(
    agent: string,
    numIdleProcesses: number,
    initializeTimeout: number,
    closeTimeout: number,
  ) {
    this.agent = agent;
    this.numIdleProcesses = numIdleProcesses;
    this.initializeTimeout = initializeTimeout;
    this.closeTimeout = closeTimeout;
  }

  get processes(): JobExecutor[] {
    return this.executors;
  }

  getByJobId(id: string): JobExecutor | null {
    return this.executors.find((x) => x.runningJob && x.runningJob.job.id === id) || null;
  }

  async launchJob(info: RunningJobInfo) {
    const proc = await this.warmedDequeue();
    if (this.procUnlock) {
      this.procUnlock();
      this.procUnlock = undefined;
    }
    await proc.launchJob(info);
  }

  async procWatchTask() {
    const proc = new ProcJobExecutor(this.agent, this.initializeTimeout, this.closeTimeout);

    try {
      this.executors.push(proc);

      const unlock = await this.initMutex.lock();
      if (this.closed) {
        return;
      }

      await proc.start();
      try {
        await proc.initialize();
        this.warmedEnqueue(proc);
      } catch {
        if (this.procUnlock) {
          this.procUnlock();
          this.procUnlock = undefined;
        }
      }

      unlock();
      await proc.join();
    } finally {
      this.executors.splice(this.executors.indexOf(proc));
    }
  }

  start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.run(this.controller.signal);
  }

  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      this.procUnlock = await this.procMutex.lock();
      const task = this.procWatchTask();
      this.tasks.push(task);
      task.finally(() => this.tasks.splice(this.tasks.indexOf(task)));
    }
  }

  async close() {
    if (!this.started) {
      return;
    }
    this.closed = true;
    this.controller.abort();
    await Promise.allSettled(this.tasks);
  }
}
