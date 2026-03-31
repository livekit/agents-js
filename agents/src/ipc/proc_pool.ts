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
  // Keep each lock token paired with its warmed process so MultiMutex slots are always released correctly.
  warmedProcQueue = new Queue<{ proc: JobExecutor; unlock: () => void }>();
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
      const entry = await this.warmedProcQueue.get();
      proc = entry.proc;
      // Release exactly the slot that produced this warmed process.
      entry.unlock();
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

  async procWatchTask(procUnlock: () => void) {
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
        await this.warmedProcQueue.put({ proc, unlock: procUnlock });
      } catch {
        // Initialization failed before enqueue, so release the acquired slot immediately.
        procUnlock();
      }

      unlock();
      await proc.join();
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
    if (this.procMutex) {
      while (!signal.aborted) {
        const procUnlock = await this.procMutex.lock();
        const task = this.procWatchTask(procUnlock);
        this.tasks.push(task);
        task.finally(() => {
          const taskIndex = this.tasks.indexOf(task);
          if (taskIndex !== -1) {
            this.tasks.splice(taskIndex, 1);
          } else {
            throw new Error(`task ${task} not found in tasks`);
          }
        });
      }
    }
  }

  async close() {
    if (!this.started) {
      return;
    }
    this.closed = true;
    this.controller.abort();
    this.warmedProcQueue.items.forEach((e) => {
      e.unlock();
      e.proc.close();
    });
    this.executors.forEach((e) => e.close());
    await Promise.allSettled(this.tasks);
  }
}
