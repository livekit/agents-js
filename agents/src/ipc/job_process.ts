// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Job } from '@livekit/protocol';
import { IPC_MESSAGE, JobMainArgs, Message, Pong, StartJobResponse } from './protocol';
import { runJob } from './job_main';
import { EventEmitter, once } from 'events';
import { log } from '../log';
import { AcceptData } from '../job_request';
import { Logger } from 'pino';

const START_TIMEOUT = 90 * 1000;
const PING_INTERVAL = 5 * 1000;
const PING_TIMEOUT = 90 * 1000;
const HIGH_PING_THRESHOLD = 10;

export class JobProcess {
  #job: Job;
  args: JobMainArgs;
  event: EventEmitter;
  logger: Logger;
  startTimeout?: Timer;
  pongTimeout?: Timer;
  pingInterval?: Timer;

  constructor(job: Job, url: string, token: string, acceptData: AcceptData) {
    this.#job = job;
    this.args = { jobID: job.id, url, token, acceptData };
    this.event = new EventEmitter();
    this.logger = log.child({ job_id: this.#job.id });
  }

  get job(): Job {
    return this.#job;
  }

  async close() {
    this.logger.info('closing job process');
    this.event.emit('msg', { type: IPC_MESSAGE.ShutdownRequest });
    await this.clear();
    await once(this.event, 'exit')
    this.logger.info('job process closed');
  }

  async clear() {
    clearTimeout(this.startTimeout)
    clearTimeout(this.pongTimeout)
    clearTimeout(this.pingInterval)
  }

  async run() {
    let resp: StartJobResponse | undefined = undefined;

    runJob(this.event, this.args);
    this.event.emit('msg', { type: IPC_MESSAGE.StartJobRequest, job: this.job });

    this.startTimeout = setTimeout(() => {
      if (resp === undefined) {
        this.logger.error('process start timed out, killing job');
        this.close();
      }
    }, START_TIMEOUT);

    this.pingInterval = setInterval(() => {
      this.event.emit('msg', { type: IPC_MESSAGE.Ping, timestamp: Date.now() });
    }, PING_INTERVAL);

    this.pongTimeout = setTimeout(() => {
      this.logger.error('job ping timed out, killing job');
      this.close();
    }, PING_TIMEOUT);

    this.event.on('msg', (msg: Message) => {
      if (msg.type === IPC_MESSAGE.StartJobResponse) {
        resp = msg as StartJobResponse;
      } else if (msg.type === IPC_MESSAGE.Pong) {
        const delay = Date.now() - (msg as Pong).timestamp;
        if (delay > HIGH_PING_THRESHOLD) {
          this.logger.warn(`job is unresponsive (${delay}ms delay)`);
        }
        // @ts-expect-error: this actually works fine types/bun doesn't have a typedecl for it yet
        this.pongTimeout.refresh();
      } else if (msg.type === IPC_MESSAGE.UserExit || msg.type === IPC_MESSAGE.ShutdownResponse) {
        this.logger.info('job exiting');
        this.close();
      }
    });

    await once(this.event, 'exit');
  }
}
