// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { RunningJobInfo } from '../job.js';
import type { JobExecutor } from './job_executor.js';
import { ProcJobExecutor } from './proc_job_executor.js';

const MAX_CONCURRENT_INITIALIZATIONS = 3;

export class ProcPool {
  agent: string;
  numIdleProcesses: number;
  initializeTimeout: number;
  closeTimeout: number;
  executors: JobExecutor[] = [];
  tasks: Promise<void>[] = [];
  started = false;
  closed = false;

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

  // equivalent to init_sem
  initQueue: (() => void)[] = [];
  initDequeue() {
    if (this.procQueue.length > 0) {
      const next = this.procQueue.shift();
      if (next) {
        next();
      }
    }
  }
  async initEnqueue() {
    if (this.initQueue.length < MAX_CONCURRENT_INITIALIZATIONS) {
      return;
    } else {
      return new Promise<void>((resolve) => {
        this.initQueue.push(resolve);
      });
    }
  }

  // equivalent to proc_needed_sem
  procQueue: (() => void)[] = [];
  async procEnqueue() {
    if (this.warmedProcQueue.length < this.numIdleProcesses) {
      return;
    } else {
      return new Promise<void>((resolve) => {
        this.procQueue.push(resolve);
      });
    }
  }
  procDequeue() {
    if (this.procQueue.length > 0) {
      const next = this.procQueue.shift();
      if (next) {
        next();
      }
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
    this.procDequeue();
    await proc.launchJob(info);
  }

  async procWatchTask() {
    const proc = new ProcJobExecutor(this.agent, this.initializeTimeout, this.closeTimeout);

    try {
      this.executors.push(proc);

      await this.initEnqueue();
      if (this.closed) {
        return;
      }

      await proc.start();
      try {
        await proc.initialize();
        this.warmedEnqueue(proc);
      } catch {
        this.procDequeue();
      }

      this.initDequeue();

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
    this.run();
  }

  async run() {
    while (true) {
      await this.procEnqueue();
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
    await Promise.allSettled(this.tasks);
  }
}
