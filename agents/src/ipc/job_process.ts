// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Job } from '@livekit/protocol';
import {
  JobMainArgs,
  Log,
  Message,
  Ping,
  Pong,
  ShutdownRequest,
  ShutdownResponse,
  StartJobRequest,
  StartJobResponse,
  UserExit,
} from './protocol';
import { JobContext } from '../job_context';
import { runJob } from './job_main';
import { EventEmitter } from 'events';
import { log } from '../log';

const START_TIMEOUT = 90 * 1000;
const PING_INTERVAL = 5 * 1000;
const PING_TIMEOUT = 90 * 1000;
const HIGH_PING_THRESHOLD = 10;

export class JobProcess {
  #job: Job;
  args: JobMainArgs;
  logger = log.child({ job_id: this.job.id });
  event: EventEmitter;
  closed = false;

  constructor(job: Job, url: string, token: string, target: (arg: JobContext) => void) {
    this.#job = job;
    this.args = { jobID: job.id, url, token, target };
    this.event = new EventEmitter();
  }

  get job(): Job {
    return this.#job;
  }

  async close() {
    this.logger.info('closing job process');
    this.event.emit('msg', new ShutdownRequest());
    this.event.removeAllListeners();
  }

  async run() {
    let resp: StartJobResponse | undefined = undefined;

    runJob(this.event, this.args);
    this.event.emit('msg', new StartJobRequest(this.job));

    setTimeout(() => {
      if (resp === undefined) {
        this.logger.error('process start timed out, killing job');
        this.closed = true;
      }
    }, START_TIMEOUT);

    const pingInterval = setInterval(() => {
      if (this.closed) clearInterval(pingInterval);
      else {
        this.event.emit('msg', new Ping(Date.now()));
      }
    }, PING_INTERVAL);

    const pongTimeout = setTimeout(() => {
      this.logger.error('job ping timed out, killing job');
      this.closed = true;
    }, PING_TIMEOUT);

    while (!this.closed) {
      this.event.on('msg', (msg: Message) => {
        if (msg instanceof StartJobResponse) {
          resp = msg;
        } else if (msg instanceof Log) {
          switch (msg.level) {
            // pino uses 10, 20, ..., 60 as representations for log levels
            case 10:
              this.logger.trace(msg.message);
              break;
            case 20:
              this.logger.debug(msg.message);
              break;
            case 30:
              this.logger.info(msg.message);
              break;
            case 40:
              this.logger.warn(msg.message);
              break;
            case 50:
              this.logger.error(msg.message);
              break;
            case 60:
              this.logger.fatal(msg.message);
              break;
          }
        } else if (msg instanceof Pong) {
          const delay = Date.now() - msg.timestamp;
          if (delay > HIGH_PING_THRESHOLD) {
            this.logger.warn(`job is unresponsive (${delay}ms delay)`);
            // @ts-expect-error: this actually works fine types/bun doesn't have a typedecl for it yet
            pongTimeout.refresh();
          }
        } else if (msg instanceof UserExit || msg instanceof ShutdownResponse) {
          this.logger.info('job exiting');
          this.closed = true;
        }
      });
    }

    this.logger.info('job process closed');
  }
}
