// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import { type Throws, ThrowsPromise } from '@livekit/throws-transformer/throws';
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
  spawnTasks: Set<Promise<void>> = new Set();
  started = false;
  closed = false;
  controller = new AbortController();
  initMutex = new Mutex();

  targetIdleProcesses: number;
  defaultNumIdleProcesses: number;
  jobsWaitingForProcess = 0;

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
    this.targetIdleProcesses = numIdleProcesses;
    this.defaultNumIdleProcesses = numIdleProcesses;
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

  setTargetIdleProcesses(num: number) {
    this.targetIdleProcesses = num;
  }

  async launchJob(info: RunningJobInfo): Promise<Throws<void, Error>> {
    let proc: JobExecutor;
    this.jobsWaitingForProcess++;
    try {
      if (
        this.warmedProcQueue.items.length === 0 &&
        this.spawnTasks.size < this.jobsWaitingForProcess
      ) {
        const task = this.procWatchTask();
        this.spawnTasks.add(task);
        task.finally(() => this.spawnTasks.delete(task));
      }
      proc = await this.warmedProcQueue.get();
    } finally {
      this.jobsWaitingForProcess--;
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
      let initReleased = false;
      try {
        if (this.closed) {
          return;
        }

        await proc.start();
        try {
          await proc.initialize();
          await this.warmedProcQueue.put(proc);
          unlock();
          initReleased = true;
        } catch {
          // Initialization failed before enqueue
        }

        await proc.join();
      } finally {
        if (!initReleased) {
          unlock();
        }
      }
    } finally {
      const procIndex = this.executors.indexOf(proc);
      if (procIndex !== -1) {
        this.executors.splice(procIndex, 1);
      } else {
        throw new Error(`proc ${proc} not found in executors`);
      }
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
      const currentPending = this.warmedProcQueue.items.length + this.spawnTasks.size;
      const target = Math.max(
        Math.min(this.targetIdleProcesses, this.defaultNumIdleProcesses),
        this.jobsWaitingForProcess,
      );
      const toSpawn = target - currentPending;

      for (let i = 0; i < toSpawn; i++) {
        const task = this.procWatchTask();
        this.spawnTasks.add(task);
        task.finally(() => this.spawnTasks.delete(task));
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 100);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  async close() {
    if (!this.started) {
      return;
    }
    this.closed = true;
    this.controller.abort();
    this.warmedProcQueue.items.forEach((proc) => {
      proc.close();
    });
    this.executors.forEach((e) => e.close());
    await ThrowsPromise.allSettled(Array.from(this.spawnTasks));
  }
}
