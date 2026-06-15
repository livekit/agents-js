// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { extname } from 'node:path';
import { InferenceRunner } from '../inference_runner.js';
import { log } from '../log.js';
import { shortuuid } from '../utils.js';
import type { InferenceExecutor } from './inference_executor.js';
import type { IPCMessage } from './message.js';
import { SupervisedProc } from './supervised_proc.js';

class PendingInference {
  promise = new ThrowsPromise<{ requestId: string; data: unknown; error?: Error }, never>(
    (resolve) => {
      this.resolve = resolve;
    },
  );
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

  protected get processKind(): string {
    return 'inference';
  }

  /**
   * Build an executor configured with the standard supervision defaults, or
   * `undefined` when no plugin has registered an {@link InferenceRunner} (in
   * which case there is nothing to run in a child process).
   *
   * `initializeTimeout` is the only knob that varies between callers: loading
   * model files into the child can be slow on first run, so the console grants
   * a longer window than the worker.
   */
  static createIfNeeded({
    initializeTimeout,
  }: {
    initializeTimeout: number;
  }): InferenceProcExecutor | undefined {
    if (Object.keys(InferenceRunner.registeredRunners).length === 0) {
      return undefined;
    }
    return new InferenceProcExecutor({
      runners: InferenceRunner.registeredRunners,
      initializeTimeout,
      closeTimeout: 5000,
      memoryWarnMB: 2000,
      memoryLimitMB: 0,
      pingInterval: 5000,
      pingTimeout: 60000,
      highPingThreshold: 2500,
    });
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
