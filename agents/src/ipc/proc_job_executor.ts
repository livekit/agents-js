// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { RunningJobInfo } from '../job.js';
import { log, loggerOptions } from '../log.js';
import { Future } from '../utils.js';
import type { ProcOpts } from './job_executor.js';
import { JobExecutor } from './job_executor.js';
import type { IPCMessage } from './message.js';

export class ProcJobExecutor extends JobExecutor {
  #opts: ProcOpts;
  #started = false;
  #closing = false;
  #runningJob?: RunningJobInfo = undefined;
  #proc?: ChildProcess;
  #pingInterval?: ReturnType<typeof setInterval>;
  #pongTimeout?: ReturnType<typeof setTimeout>;
  #init = new Future();
  #join = new Future();
  #logger = log().child({ runningJob: this.#runningJob });

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

  get runningJob(): RunningJobInfo | undefined {
    return this.#runningJob;
  }

  async start() {
    if (this.#started) {
      throw new Error('runner already started');
    } else if (this.#closing) {
      throw new Error('runner is closed');
    }

    this.#proc = await import('./job_main.js').then((m) =>
      m.runProcess({
        agentFile: this.#opts.agent,
      }),
    );

    this.#started = true;
    this.run();
  }

  async run() {
    await this.#init.await;

    this.#pingInterval = setInterval(() => {
      this.#proc!.send({ case: 'pingRequest', value: { timestamp: Date.now() } });
    }, this.PING_INTERVAL);

    this.#pongTimeout = setTimeout(() => {
      this.#logger.warn('job is unresponsive');
      clearTimeout(this.#pongTimeout);
      clearInterval(this.#pingInterval);
      this.#proc!.kill();
      this.#join.resolve();
    }, this.PING_TIMEOUT);

    const listener = (msg: IPCMessage) => {
      switch (msg.case) {
        case 'pongResponse': {
          const delay = Date.now() - msg.value.timestamp;
          if (delay > this.HIGH_PING_THRESHOLD) {
            this.#logger.child({ delay }).warn('job executor is unresponsive');
          }
          this.#pongTimeout?.refresh();
          break;
        }
        case 'exiting': {
          this.#logger.child({ reason: msg.value.reason }).debug('job exiting');
          break;
        }
        case 'done': {
          this.#closing = true;
          this.#proc!.off('message', listener);
          this.#join.resolve();
          break;
        }
      }
    };
    this.#proc!.on('message', listener);
    this.#proc!.on('error', (err) => {
      if (this.#closing) return;
      this.#logger.child({ err }).warn('job process exited unexpectedly');
      clearTimeout(this.#pongTimeout);
      clearInterval(this.#pingInterval);
      this.#join.resolve();
    });

    await this.#join.await;
  }

  async join() {
    if (!this.#started) {
      throw new Error('runner not started');
    }

    await this.#join.await;
  }

  async initialize() {
    const timer = setTimeout(() => {
      const err = new Error('runner initialization timed out');
      this.#init.reject(err);
      throw err;
    }, this.#opts.initializeTimeout);
    this.#proc!.send({ case: 'initializeRequest', value: { loggerOptions } });
    await once(this.#proc!, 'message').then(([msg]: IPCMessage[]) => {
      clearTimeout(timer);
      if (msg!.case !== 'initializeResponse') {
        throw new Error('first message must be InitializeResponse');
      }
    });
    this.#init.resolve();
  }

  async close() {
    if (!this.#started) {
      return;
    }
    this.#closing = true;

    if (!this.#runningJob) {
      this.#proc!.kill();
      this.#join.resolve();
    }

    this.#proc!.send({ case: 'shutdownRequest' });

    const timer = setTimeout(() => {
      this.#logger.error('job shutdown is taking too much time');
    }, this.#opts.closeTimeout);
    await this.#join.await.then(() => {
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
    this.#proc!.send({ case: 'startJobRequest', value: { runningJob: info } });
  }
}
