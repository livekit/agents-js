import { ChildProcess, fork } from "node:child_process";
import { RunningJobInfo } from "../job.js";
import { InferenceExecutor } from "./inference_executor.js";
import { JobStatus } from "./job_executor.js";
import { SupervisedProc } from "./supervised_proc.js";

export class JobProcExecutor extends SupervisedProc {
  #userArgs?: any;
  #jobStatus?: JobStatus;
  #runningJob?: RunningJobInfo;
  #agent: string
  #inferenceExecutor?: InferenceExecutor;
  #inferenceTasks: Promise<void>[] = [];
  
  constructor({
    agent,
    inferenceExecutor,
    initializeTimeout,
    closeTimeout,
    memoryWarnMB,
    memoryLimitMB,
    pingInterval,
    pingTimeout,
    highPingThreshold
  }: {
    agent: string,
    inferenceExecutor?: InferenceExecutor,
    initializeTimeout: number,
    closeTimeout: number,
    memoryWarnMB: number,
    memoryLimitMB: number,
    pingInterval: number,
    pingTimeout: number,
    highPingThreshold: number,
  }) {
    super(agent, initializeTimeout, closeTimeout, memoryWarnMB, memoryLimitMB, pingInterval, pingTimeout, highPingThreshold);
    this.#agent = agent
    this.#inferenceExecutor = inferenceExecutor
  }

  get status(): JobStatus {
    if (this.#jobStatus) {
      return this.#jobStatus
    }
    throw new Error("job status not available")
  }

  get userArguments(): any {
    return this.#userArgs
  }

  set userArguments(args: any) {
    this.#userArgs = args
  }

  get runningJob(): RunningJobInfo | undefined {
    return this.#runningJob
  }

  #createProcess(): ChildProcess {
    return fork(new URL(import.meta.resolve('./job_proc_lazy_main.js')), [this.#agent])
  }
}
