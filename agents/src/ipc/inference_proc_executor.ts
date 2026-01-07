// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { extname } from 'node:path';
import { log } from '../log.js';
import { shortuuid } from '../utils.js';
import type { InferenceExecutor } from './inference_executor.js';
import type { IPCMessage } from './message.js';
import { SupervisedProc } from './supervised_proc.js';

class PendingInference {
  promise = new Promise<{ requestId: string; data: unknown; error?: Error }>((resolve) => {
    this.resolve = resolve;
  });
  resolve(arg: { requestId: string; data: unknown; error?: Error }) {
    arg;
  }
}

const currentFileExtension = extname(import.meta.url);

export class InferenceProcExecutor extends SupervisedProc implements InferenceExecutor {
  #runners: { [id: string]: string };
  #activeRequests: { [id: string]: PendingInference } = {};
  #logger = log();

  constructor({
    runners,
    initializeTimeout,
    closeTimeout,
    memoryWarnMB,
    memoryLimitMB,
    pingInterval,
    pingTimeout,
    highPingThreshold,
  }: {
    runners: { [id: string]: string };
    initializeTimeout: number;
    closeTimeout: number;
    memoryWarnMB: number;
    memoryLimitMB: number;
    pingInterval: number;
    pingTimeout: number;
    highPingThreshold: number;
  }) {
    super(
      initializeTimeout,
      closeTimeout,
      memoryWarnMB,
      memoryLimitMB,
      pingInterval,
      pingTimeout,
      highPingThreshold,
    );
    this.#runners = runners;
  }

  createProcess(): ChildProcess {
    const forkUrl = new URL(`./inference_proc_lazy_main${currentFileExtension}`, import.meta.url);

    // When running via tsx/ts-node (TypeScript files), we need to inherit the parent's
    // execArgv so the child process can also execute TypeScript with the same loader
    const isTypeScript = currentFileExtension === '.ts';
    const forkOptions = isTypeScript ? { execArgv: process.execArgv } : undefined;

    return fork(forkUrl, [JSON.stringify(this.#runners)], forkOptions);
  }

  async mainTask(proc: ChildProcess) {
    proc.on('message', (msg: IPCMessage) => {
      switch (msg.case) {
        case 'inferenceResponse':
          const res = this.#activeRequests[msg.value.requestId];
          delete this.#activeRequests[msg.value.requestId];
          if (!res) {
            this.#logger
              .child({ requestId: msg.value.requestId })
              .warn('received unexpected inference response');
            return;
          }

          res.resolve(msg.value);
      }
    });
  }

  async doInference(method: string, data: unknown): Promise<unknown> {
    const requestId = shortuuid('inference_req_');
    const fut = new PendingInference();
    this.proc!.send({ case: 'inferenceRequest', value: { requestId, method, data } });
    this.#activeRequests[requestId] = fut;

    const res = await fut.promise;
    if (res.error) {
      throw new Error(`inference of ${method} failed: ${res.error}`);
    }
    return res.data;
  }
}
