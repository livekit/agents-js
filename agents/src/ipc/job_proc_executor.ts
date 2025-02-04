// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import type { RunningJobInfo } from '../job.js';
import { log } from '../log.js';
import type { InferenceExecutor } from './inference_executor.js';
import type { JobExecutor } from './job_executor.js';
import { JobStatus } from './job_executor.js';
import type { IPCMessage } from './message.js';
import { SupervisedProc } from './supervised_proc.js';

export class JobProcExecutor extends SupervisedProc implements JobExecutor {
  #userArgs?: any;
  #jobStatus?: JobStatus;
  #runningJob?: RunningJobInfo;
  #agent: string;
  #inferenceExecutor?: InferenceExecutor;
  #inferenceTasks: Promise<void>[] = [];
  #logger = log();

  constructor(
    agent: string,
    inferenceExecutor: InferenceExecutor | undefined,
    initializeTimeout: number,
    closeTimeout: number,
    memoryWarnMB: number,
    memoryLimitMB: number,
    pingInterval: number,
    pingTimeout: number,
    highPingThreshold: number,
  ) {
    super(
      initializeTimeout,
      closeTimeout,
      memoryWarnMB,
      memoryLimitMB,
      pingInterval,
      pingTimeout,
      highPingThreshold,
    );
    this.#agent = agent;
    this.#inferenceExecutor = inferenceExecutor;
  }

  get status(): JobStatus {
    if (this.#jobStatus) {
      return this.#jobStatus;
    }
    throw new Error('job status not available');
  }

  get userArguments(): any {
    return this.#userArgs;
  }

  set userArguments(args: any) {
    this.#userArgs = args;
  }

  get runningJob(): RunningJobInfo | undefined {
    return this.#runningJob;
  }

  createProcess(): ChildProcess {
    return fork(new URL(import.meta.resolve('./job_proc_lazy_main.js')), [this.#agent]);
  }

  async mainTask(proc: ChildProcess) {
    proc.on('message', (msg: IPCMessage) => {
      switch (msg.case) {
        case 'inferenceRequest':
          this.#inferenceTasks.push(this.#doInferenceTask(proc, msg.value));
      }
    });
  }

  async #doInferenceTask(
    proc: ChildProcess,
    req: { method: string; requestId: string; data: unknown },
  ) {
    if (!this.#inferenceExecutor) {
      this.#logger.warn('inference request received but no inference executor');
      proc.send({
        case: 'inferenceResponse',
        value: { requestId: req.requestId, error: new Error('no inference executor') },
      });
      return;
    }

    try {
      const data = await this.#inferenceExecutor.doInference(req.method, req.data);
      proc.send({ case: 'inferenceResponse', value: { requestId: req.requestId, data } });
    } catch (error) {
      proc.send({ case: 'inferenceResponse', value: { requestId: req.requestId, error } });
    }
  }

  async launchJob(info: RunningJobInfo) {
    if (this.#runningJob) {
      throw Error('process already has a running job');
    }
    if (!this.init.done) {
      throw Error('process not initialized');
    }
    this.#jobStatus = JobStatus.RUNNING;
    this.#runningJob = info;

    this.proc!.send({ case: 'startJobRequest', value: { runningJob: info } });
  }
}
