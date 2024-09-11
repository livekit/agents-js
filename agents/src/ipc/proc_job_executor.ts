// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'child_process';
import type { RunningJobInfo } from '../job.js';
import { log } from '../log.js';
import type { ProcOpts } from './job_executor.js';
import { JobExecutor } from './job_executor.js';
import { runProcess } from './job_main.js';
import type { IPCMessage } from './message.js';

export class ProcJobExecutor extends JobExecutor {
  #opts: ProcOpts;
  #started = false;
  #closing = false;
  #userArgs: unknown = undefined;
  #runningJob?: RunningJobInfo = undefined;
  #proc?: ChildProcess;
  #pingInterval?: ReturnType<typeof setInterval>;
  #pongTimeout?: ReturnType<typeof setTimeout>;

  #init = () => {};
  #initErr = (_: Error) => {
    _;
  };
  #initPromise = new Promise<void>((resolve, reject) => {
    this.#init = resolve;
    this.#initErr = reject;
  });

  #join = () => {};
  #joinPromise = new Promise<void>((resolve) => {
    this.#join = resolve;
  });

  constructor(agent: string, initializeTimeout: number, closeTimeout: number) {
    super();
    this.#opts = {
      agent,
      initializeTimeout,
      closeTimeout,
    };
  }

  get started(): boolean {
    return this.#started;
  }

  get startArguments(): unknown {
    return this.#userArgs;
  }

  set startArguments(value: unknown) {
    this.#userArgs = value;
  }

  get runningJob(): RunningJobInfo | undefined {
    return this.#runningJob;
  }

  async start() {
    if (this.#started) {
      throw new Error('runner already started');
    } else if (this.#closing) {
      throw new Error('runner is closed');
    }

    this.#proc = runProcess({
      agentFile: this.#opts.agent,
      userArguments: this.#userArgs,
    });

    try {
      await this.#initPromise;
    } catch {}

    this.#pingInterval = setInterval(() => {
      this.#proc!.send({ case: 'pingRequest', value: { timestamp: Date.now() } });
    }, this.PING_INTERVAL);

    this.#pongTimeout = setTimeout(() => {
      log.warn('job is unresponsive');
    }, this.PING_TIMEOUT);

    const listener = (msg: IPCMessage) => {
      switch (msg.case) {
        case 'pongResponse': {
          const delay = Date.now() - msg.value.timestamp;
          if (delay > this.HIGH_PING_THRESHOLD) {
            log.child({ delay }).warn('job executor is unresponsive');
          }
          this.#pongTimeout?.refresh();
          break;
        }
        case 'exiting': {
          log.child({ reason: msg.value.reason }).debug('job exiting');
        }
        case 'done': {
          this.#proc!.off('message', listener);
          this.#join();
          break;
        }
      }
    };
    this.#proc.on('message', listener);

    await this.#joinPromise;
  }

  async join() {
    if (!this.#started) {
      throw new Error('runner not started');
    }

    await this.#joinPromise;
  }

  async initialize() {
    let gotResponse = () => {};
    const timer = setTimeout(() => {
      const err = new Error('runner initialization timed out');
      this.#initErr(err);
      throw err;
    }, this.#opts.initializeTimeout);
    this.#proc!.once('message', (msg: IPCMessage) => {
      clearTimeout(timer);
      if (msg.case !== 'initializeResponse') {
        throw new Error('first message must be InitializeResponse');
      }
      gotResponse();
    });
    const response = new Promise<void>((resolve) => {
      gotResponse = resolve;
    });

    this.#proc!.send({ case: 'initializeRequest' });
    await response;
    this.#init();
  }

  async close() {
    if (!this.#started) {
      return;
    }
    this.#closing = true;
    this.#proc!.send({ case: 'shutdownRequest' });

    const timer = setTimeout(() => {
      log.error('job shutdown is taking too much time');
    }, this.#opts.closeTimeout);
    await this.#joinPromise.then(() => {
      clearTimeout(timer);
      clearTimeout(this.#pongTimeout);
      clearInterval(this.#pingInterval);
    });
  }

  async launchJob(info: RunningJobInfo) {
    if (this.#runningJob) {
      throw new Error('executor already has a running job');
    }
    this.#runningJob = info;
    this.#proc!.send({ case: 'startJobRequest', value: info });
  }
}
