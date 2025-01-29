import { ChildProcess, fork } from "node:child_process";
import { RunningJobInfo } from "../job.js";
import { InferenceExecutor } from "./inference_executor.js";
import { JobStatus } from "./job_executor.js";
import { SupervisedProc } from "./supervised_proc.js";
import { IPCMessage } from "./message.js";
import { log } from "../log.js";

export class JobProcExecutor extends SupervisedProc {
  #userArgs?: any;
  #jobStatus?: JobStatus;
  #runningJob?: RunningJobInfo;
  #agent: string
  #inferenceExecutor?: InferenceExecutor;
  #inferenceTasks: Promise<void>[] = [];
  #proc?: ChildProcess
  #logger = log()

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
    super(initializeTimeout, closeTimeout, memoryWarnMB, memoryLimitMB, pingInterval, pingTimeout, highPingThreshold);
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

  createProcess(): ChildProcess {
    const proc = fork(new URL(import.meta.resolve('./job_proc_lazy_main.js')), [this.#agent])
    this.#proc = proc;
    return proc;
  }

  async mainTask(child: ChildProcess) {
    child.on('message', (msg: IPCMessage) => {
      switch (msg.case) {
        case "inferenceRequest":
          this.#inferenceTasks.push(this.#doInferenceTask(msg.value))
      }
    })
  }

  async #doInferenceTask(req: { method: string; requestId: string; data: unknown }) {
    if (!this.#inferenceExecutor) {
      this.#logger.warn("inference request received but no inference executor")
      this.#proc!.send({ case: 'inferenceResponse', value: { requestId: req.requestId, error: new Error('no inference executor') } })
      return
    }

    try {
      const data = await this.#inferenceExecutor.doInference(req.method, req.data)
      this.#proc!.send({ case: 'inferenceResponse', value: { requestId: req.requestId, data } })
    } catch (error) {
      this.#proc!.send({ case: 'inferenceResponse', value: { requestId: req.requestId, error } })
    }
  }

  async launchJob(info: RunningJobInfo) {
    if (this.#runningJob) {
      throw Error("process already has a running job")
    }
    if (!this.init.done) {
      throw Error("process not initialized")
    }
    this.#jobStatus = JobStatus.RUNNING
    this.#runningJob = info
    
    this.#proc!.send({ case: 'startJobRequest', value: { runningJob: info } })
  }
}
