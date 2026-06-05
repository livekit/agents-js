// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { MultiMutex, Mutex } from '@livekit/mutex';
import { type Throws, ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { RunningJobInfo } from '../job.js';
import { Queue } from '../utils.js';
import type { InferenceExecutor } from './inference_executor.js';
import type { JobExecutor } from './job_executor.js';
import { JobProcExecutor } from './job_proc_executor.js';

const MAX_PROC_ACQUIRE_ATTEMPTS = 3;

type WarmedProcEntry = { proc: JobExecutor; unlock: () => void };

export class ProcPool {
  agent: string;
  initializeTimeout: number;
  closeTimeout: number;
  executors: JobExecutor[] = [];
  tasks: Promise<void>[] = [];
  spawnTasks: Promise<void>[] = [];
  started = false;
  closed = false;
  controller = new AbortController();
  initMutex = new Mutex();
  procMutex?: MultiMutex;
  // Keep each lock token paired with its warmed process so MultiMutex slots are always released correctly.
  warmedProcQueue = new Queue<WarmedProcEntry>();
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

  private async acquireProc(): Promise<Throws<JobExecutor, Error>> {
    for (let attempt = 0; attempt < MAX_PROC_ACQUIRE_ATTEMPTS; attempt++) {
      const entry = await this.acquireWarmedProcEntry();
      if (entry) {
        entry.unlock();
        return entry.proc;
      }
    }

    throw new Error(`no process became available after ${MAX_PROC_ACQUIRE_ATTEMPTS} attempts`);
  }

  private async acquireWarmedProcEntry(): Promise<Throws<WarmedProcEntry | undefined, Error>> {
    if (this.warmedProcQueue.items.length > 0) {
      return this.warmedProcQueue.get();
    }

    if (this.spawnTasks.length === 0 && this.procMutex) {
      this.trackProcSpawn(this.procMutex.lock());
    }

    const spawns = [...this.spawnTasks];
    if (spawns.length === 0) {
      return undefined;
    }

    const abortController = new AbortController();
    const queueReady = this.warmedProcQueue
      .waitForItem({ signal: abortController.signal })
      .then(() => true)
      .catch(() => false);
    const spawnsDone = Promise.allSettled(spawns).then(() => false);
    const result = await Promise.race([queueReady, spawnsDone]);
    abortController.abort();

    if (result && this.warmedProcQueue.items.length > 0) {
      return this.warmedProcQueue.get();
    }

    return undefined;
  }

  async launchJob(info: RunningJobInfo): Promise<Throws<void, Error>> {
    let proc: JobExecutor;
    if (this.procMutex) {
      proc = await this.acquireProc();
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

  async procWatchTask(procUnlock: () => void, spawnSettled?: () => void) {
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
      let procUnlockTransferred = false;
      let spawnSettledCalled = false;
      const markSpawnSettled = () => {
        if (!spawnSettledCalled) {
          spawnSettledCalled = true;
          spawnSettled?.();
        }
      };
      try {
        if (this.closed) {
          return;
        }

        await proc.start();
        try {
          await proc.initialize();
          await this.warmedProcQueue.put({ proc, unlock: procUnlock });
          procUnlockTransferred = true;
          markSpawnSettled();
          // Release initMutex after enqueue — holding it through join() serialises
          // the pool to concurrency 1 since child procs are one-shot.
          unlock();
          initReleased = true;
        } catch {
          // Initialization failed before enqueue, so release the acquired slot immediately.
          markSpawnSettled();
        }

        await proc.join();
      } finally {
        markSpawnSettled();
        if (!initReleased) {
          unlock();
        }
        if (!procUnlockTransferred) {
          procUnlock();
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

  private startProcWatchTask(procUnlock: () => void): Promise<void> {
    let markSpawnSettled: () => void = () => {};
    const spawnTask = new Promise<void>((resolve) => {
      markSpawnSettled = resolve;
    });

    const task = this.procWatchTask(procUnlock, markSpawnSettled);
    this.tasks.push(task);
    task.finally(() => {
      markSpawnSettled();
      const taskIndex = this.tasks.indexOf(task);
      if (taskIndex !== -1) {
        this.tasks.splice(taskIndex, 1);
      } else {
        throw new Error(`task ${task} not found in tasks`);
      }
    });

    return spawnTask;
  }

  private trackProcSpawn(procUnlockPromise: Promise<() => void>) {
    const spawnTask = procUnlockPromise.then((procUnlock) => this.startProcWatchTask(procUnlock));
    this.spawnTasks.push(spawnTask);
    spawnTask.finally(() => {
      const taskIndex = this.spawnTasks.indexOf(spawnTask);
      if (taskIndex !== -1) {
        this.spawnTasks.splice(taskIndex, 1);
      } else {
        throw new Error(`spawn task ${spawnTask} not found in spawnTasks`);
      }
    });
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
        const procUnlockPromise = this.procMutex.lock();
        this.trackProcSpawn(procUnlockPromise);
        await procUnlockPromise;
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
    await ThrowsPromise.allSettled(this.tasks);
  }
}
