// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Job } from '@livekit/protocol';
import type { ChildProcess } from 'child_process';
import { once } from 'events';
import type { Logger } from 'pino';
import type { AcceptData } from '../job_request.js';
import { log } from '../log.js';
import {
  IPC_MESSAGE,
  type JobMainArgs,
  type Message,
  type Pong,
  type StartJobResponse,
} from './protocol.js';

const START_TIMEOUT = 90 * 1000;
const PING_INTERVAL = 5 * 1000;
const PING_TIMEOUT = 90 * 1000;
const HIGH_PING_THRESHOLD = 10;

export class JobProcess {
  #job: Job;
  args: JobMainArgs;
  logger: Logger;
  process?: ChildProcess;
  startTimeout?: ReturnType<typeof setTimeout>;
  pongTimeout?: ReturnType<typeof setTimeout>;
  pingInterval?: ReturnType<typeof setInterval>;

  constructor(job: Job, acceptData: AcceptData, raw: string, fallbackURL: string) {
    this.#job = job;
    this.args = { entry: acceptData.entry, raw, fallbackURL };
    this.logger = log.child({ job_id: this.#job.id });
  }

  get job(): Job {
    return this.#job;
  }

  async close() {
    this.logger.debug('closing job process');
    await this.clear();
    this.process!.send({ type: IPC_MESSAGE.ShutdownRequest });
    await once(this.process!, 'disconnect');
    this.logger.info('job process closed');
  }

  async clear() {
    clearTimeout(this.startTimeout);
    clearTimeout(this.pongTimeout);
    clearInterval(this.pingInterval);
  }

  async run() {
    let resp: StartJobResponse | undefined = undefined;

    this.startTimeout = setTimeout(() => {
      if (resp === undefined) {
        this.logger.error('process start timed out, killing job');
        this.process?.kill();
        this.clear();
      }
    }, START_TIMEOUT);

    this.pingInterval = setInterval(() => {
      this.process?.send({ type: IPC_MESSAGE.Ping, timestamp: Date.now() });
    }, PING_INTERVAL);

    this.pongTimeout = setTimeout(() => {
      this.logger.error('job ping timed out, killing job');
      this.process?.kill();
      this.clear();
    }, PING_TIMEOUT);

    this.process = await import('./job_main.js').then((main) => main.runJob(this.args));

    this.process.on('message', (msg: Message) => {
      if (msg.type === IPC_MESSAGE.StartJobResponse) {
        resp = msg as StartJobResponse;
      } else if (msg.type === IPC_MESSAGE.Pong) {
        const delay = Date.now() - (msg as Pong).timestamp;
        if (delay > HIGH_PING_THRESHOLD) {
          this.logger.warn(`job is unresponsive (${delay}ms delay)`);
        }
        this.pongTimeout?.refresh();
      } else if (msg.type === IPC_MESSAGE.UserExit || msg.type === IPC_MESSAGE.ShutdownResponse) {
        this.logger.debug('job exiting');
        this.clear();
      }
    });

    await once(this.process, 'disconnect');
  }
}
