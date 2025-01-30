import { ChildProcess, fork } from "node:child_process";
import { InferenceRunner } from "../inference_runner.js";
import { IPCMessage } from "./message.js";
import { log } from "../log.js";
import { InferenceExecutor } from "./inference_executor.js";
import { randomUUID } from "node:crypto";
import { SupervisedProc } from "./supervised_proc.js";

class PendingInference {
  promise = new Promise<{ requestId: string; data: unknown; error?: Error }>((resolve) => {
    this.resolve = resolve;
  });
  resolve(arg: { requestId: string; data: unknown; error?: Error }) {
    arg;
  }
}

export class InferenceProcExecutor extends SupervisedProc implements InferenceExecutor {
  #runners: { [id: string]: InferenceRunner; };
  #activeRequests: { [id: string]: PendingInference } = {}
  #logger = log();

  constructor(
    runners: { [id: string]: InferenceRunner },
    initializeTimeout: number,
    closeTimeout: number,
    memoryWarnMB: number,
    memoryLimitMB: number,
    pingInterval: number,
    pingTimeout: number,
    highPingThreshold: number,
  ) {
    super(initializeTimeout, closeTimeout, memoryWarnMB, memoryLimitMB, pingInterval, pingTimeout, highPingThreshold);
    this.#runners = runners
  }

  createProcess(): ChildProcess {
    return fork(new URL(import.meta.resolve('./inference_proc_lazy_main.js')), [this.#runners]) // TODO(nbsp): runner is not cloneable
  }

  async mainTask(proc: ChildProcess) {
    proc.on('message', (msg: IPCMessage) => {
      switch (msg.case) {
        case "inferenceResponse":
          const res = this.#activeRequests[msg.value.requestId];
          delete this.#activeRequests[msg.value.requestId];
          if (!res) {
            this.#logger.child({ requestId: msg.value.requestId }).warn("received unexpected inference response")
            return
          }

          res.resolve(msg.value);
      }
    })
  }

  async doInference(method: string, data: unknown): Promise<unknown> {
    const requestId = "inference_req_" + randomUUID()
    const fut = new PendingInference()
    this.proc!.send({ case: 'inferenceRequest', value: { requestId, method, data }})
    this.#activeRequests[requestId] = fut;

    const res = await fut.promise
    if (res.error) {
      throw new Error(`inference of ${method} failed: ${res.error}`)
    }
    return res.data;
  }
}
