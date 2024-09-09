// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { JobContext, JobExecutorType, JobProcess, RunningJobInfo } from '../job.js';

const MAX_CONCURRENT_INITIALIZATIONS = 3;

export class ProcPool {
  initializeProcessFunc: (proc: JobProcess) => any;
  jobEntrypointFunc: (ctx: JobContext) => Promise<void>;
  numIdleProcesses: number;
  jobExecutorType: JobExecutorType;
  initializeTimeout: number;
  closeTimeout: number;
  executors: JobExecutor[] = [];
  tasks: Promise<void>[] = [];
  started = false;
  closed = false;
  queue = [];

  advanceQueue = () => {};
  queueNext = new Promise<void>((resolve) => {
    if (this.queue.length < MAX_CONCURRENT_INITIALIZATIONS) {
      resolve();
    }
    this.advanceQueue = resolve;
  });

  constructor(
    initializeProcessFunc: (proc: JobProcess) => any,
    jobEntrypointFunc: (ctx: JobContext) => Promise<void>,
    numIdleProcesses: number,
    jobExecutorType: JobExecutorType,
    initializeTimeout: number,
    closeTimeout: number,
  ) {
    this.initializeProcessFunc = initializeProcessFunc;
    this.jobEntrypointFunc = jobEntrypointFunc;
    this.numIdleProcesses = numIdleProcesses;
    this.jobExecutorType = jobExecutorType;
    this.initializeTimeout = initializeTimeout;
    this.closeTimeout = closeTimeout;
  }

  get processes(): JobExecutor[] {
    return this.executors;
  }

  getByJobId(id: string): JobExecutor | null {
    this.executors.find((x) => x.runningJob && x.runningJob.job.id === id) || null;
  }

  async launchJob(info: RunningJobInfo) {
    // TODO(nbsp): wait for next in queue
    this.advanceQueue();
    await proc.launchJob(info);
  }

  async procWatchTask() {
    let proc: JobExecutor;
    switch (this.jobExecutorType) {
      case JobExecutorType.THREAD: {
        proc = new ThreadJobExecutor(
          this.initializeProcessFunc,
          this.jobEntrypointFunc,
          this.initializeTimeout,
          this.closeTimeout,
        );
        break;
      }
      case JobExecutorType.PROCESS: {
        proc = new ProcJobExecutor(
          this.initializeProcessFunc,
          this.jobEntrypointFunc,
          this.initializeTimeout,
          this.closeTimeout,
        );
        break;
      }
    }

    try {
      this.executors.push(proc);

      // TODO(nbsp): init semaphore
      // --block--
      if (this.closed) {
        return;
      }

      await proc.start();
      try {
        await proc.initialize();
        this.queue.push(proc);
      } catch {
        this.advanceQueue();
      }
      // --end block--

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
      await this.queueNext(); // TODO(nbsp): this only works once
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
