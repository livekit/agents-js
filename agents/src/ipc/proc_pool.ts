// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { MultiMutex, Mutex } from '@livekit/mutex';
import type { RunningJobInfo } from '../job.js';
import { Queue } from '../utils.js';
import type { InferenceExecutor } from './inference_executor.js';
import type { JobExecutor } from './job_executor.js';
import { JobProcExecutor } from './job_proc_executor.js';

export class ProcPool {
  agent: string;
  initializeTimeout: number;
  closeTimeout: number;
  executors: JobExecutor[] = [];
  tasks: Promise<void>[] = [];
  started = false;
  closed = false;
  controller = new AbortController();
  initMutex = new Mutex();
  procMutex?: MultiMutex;
  procUnlock?: () => void;
  warmedProcQueue = new Queue<JobExecutor>();
  inferenceExecutor?: InferenceExecutor;
  memoryWarnMB: number;
  memoryLimitMB: number;

  constructor(
    agent: string,
    numIdleProcesses: number,
    initializeTimeout: number,
    closeTimeout: number,
    inferenceExecutor: InferenceExecutor | undefined,
    memoryWarnMB: number,
    memoryLimitMB: number,
  ) {
    this.agent = agent;
    if (numIdleProcesses > 0) {
      this.procMutex = new MultiMutex(numIdleProcesses);
    }
    this.initializeTimeout = initializeTimeout;
    this.closeTimeout = closeTimeout;
    this.inferenceExecutor = inferenceExecutor;
    this.memoryWarnMB = memoryWarnMB;
    this.memoryLimitMB = memoryLimitMB;
  }

  get processes(): JobExecutor[] {
    return this.executors;
  }

  getByJobId(id: string): JobExecutor | null {
    return this.executors.find((x) => x.runningJob && x.runningJob.job.id === id) || null;
  }

  async launchJob(info: RunningJobInfo) {
    let proc: JobExecutor;
    if (this.procMutex) {
      proc = await this.warmedProcQueue.get();
      if (this.procUnlock) {
        this.procUnlock();
        this.procUnlock = undefined;
      }
    } else {
      proc = new JobProcExecutor(
        this.agent,
        this.inferenceExecutor,
        this.initializeTimeout,
        this.closeTimeout,
        this.memoryWarnMB,
        this.memoryLimitMB,
        2500,
        60000,
        500,
      );
      this.executors.push(proc);
      await proc.start();
      await proc.initialize();
    }
    await proc.launchJob(info);
  }

  async procWatchTask() {
    const proc = new JobProcExecutor(
      this.agent,
      this.inferenceExecutor,
      this.initializeTimeout,
      this.closeTimeout,
      this.memoryWarnMB,
      this.memoryLimitMB,
      2500,
      60000,
      500,
    );

    try {
      this.executors.push(proc);

      const unlock = await this.initMutex.lock();
      if (this.closed) {
        return;
      }

      await proc.start();
      try {
        await proc.initialize();
        await this.warmedProcQueue.put(proc);
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
    if (this.procMutex) {
      while (!signal.aborted) {
        this.procUnlock = await this.procMutex.lock();
        const task = this.procWatchTask();
        this.tasks.push(task);
        task.finally(() => this.tasks.splice(this.tasks.indexOf(task)));
      }
    }
  }

  async close() {
    if (!this.started) {
      return;
    }
    this.closed = true;
    this.controller.abort();
    this.warmedProcQueue.items.forEach((e) => e.close());
    this.executors.forEach((e) => e.close());
    await Promise.allSettled(this.tasks);
  }
}
