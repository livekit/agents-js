// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import os from 'os';
import { WebSocket } from 'ws';
import { AvailRes, JobRequest } from './job_request';
import {
  JobType,
  Job,
  WorkerMessage,
  ParticipantPermission,
  ServerMessage,
  JobAssignment,
} from '@livekit/protocol';
import { AcceptData } from './job_request';
import { HTTPServer } from './http_server';
import { log } from './log';
import { version } from './version';
import { AccessToken } from 'livekit-server-sdk';
import { EventEmitter } from 'events';
import { JobProcess } from './ipc/job_process';

const MAX_RECONNECT_ATTEMPTS = 10;
const ASSIGNMENT_TIMEOUT = 15 * 1000;
const LOAD_INTERVAL = 5 * 1000;

const cpuLoad = (): number =>
  (os
    .cpus()
    .reduce(
      (acc, x) => acc + x.times.user / Object.values(x.times).reduce((acc, x) => acc + x, 0),
      0,
    ) /
    os.cpus().length) *
  100;

class WorkerPermissions {
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
  canUpdateMetadata: boolean;
  hidden: boolean;

  constructor(
    canPublish = true,
    canSubscribe = true,
    canPublishData = true,
    canUpdateMetadata = true,
    hidden = false,
  ) {
    this.canPublish = canPublish;
    this.canSubscribe = canSubscribe;
    this.canPublishData = canPublishData;
    this.canUpdateMetadata = canUpdateMetadata;
    this.hidden = hidden;
  }
}

export class WorkerOptions {
  requestFunc: (arg: JobRequest) => Promise<void>;
  cpuLoadFunc: () => number;
  namespace: string;
  permissions: WorkerPermissions;
  workerType: JobType;
  maxRetry: number;
  wsURL: string;
  apiKey?: string;
  apiSecret?: string;
  host: string;
  port: number;

  constructor({
    requestFunc,
    cpuLoadFunc = cpuLoad,
    namespace = 'default',
    permissions = new WorkerPermissions(),
    workerType = JobType.JT_PUBLISHER,
    maxRetry = MAX_RECONNECT_ATTEMPTS,
    wsURL = 'ws://localhost:7880',
    apiKey = undefined,
    apiSecret = undefined,
    host = 'localhost',
    port = 8081,
  }: {
    requestFunc: (arg: JobRequest) => Promise<void>;
    cpuLoadFunc?: () => number;
    namespace?: string;
    permissions?: WorkerPermissions;
    workerType?: JobType;
    maxRetry?: number;
    wsURL?: string;
    apiKey?: string;
    apiSecret?: string;
    host?: string;
    port?: number;
  }) {
    this.requestFunc = requestFunc;
    this.cpuLoadFunc = cpuLoadFunc;
    this.namespace = namespace;
    this.permissions = permissions;
    this.workerType = workerType;
    this.maxRetry = maxRetry;
    this.wsURL = wsURL;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.host = host;
    this.port = port;
  }
}

class ActiveJob {
  job: Job;
  acceptData: AcceptData;

  constructor(job: Job, acceptData: AcceptData) {
    this.job = job;
    this.acceptData = acceptData;
  }
}

export class Worker {
  opts: WorkerOptions;
  #id = 'unregistered';
  session: WebSocket | undefined = undefined;
  closed = false;
  httpServer: HTTPServer;
  logger = log.child({ version });
  event = new EventEmitter();
  pending: { [id: string]: { value?: JobAssignment } } = {};
  processes: { [id: string]: { proc: JobProcess; activeJob: ActiveJob } } = {};

  constructor(opts: WorkerOptions) {
    opts.wsURL = opts.wsURL || process.env.LIVEKIT_URL || '';
    opts.apiKey = opts.apiKey || process.env.LIVEKIT_API_KEY || '';
    opts.apiSecret = opts.apiSecret || process.env.LIVEKIT_API_SECRET || '';

    this.opts = opts;
    this.httpServer = new HTTPServer(opts.host, opts.port);
  }

  get id(): string {
    return this.#id;
  }

  async run() {
    this.logger.info('starting worker');

    if (this.opts.wsURL === '') throw new Error('--url is required, or set LIVEKIT_URL env var');
    if (this.opts.apiKey === '')
      throw new Error('--api-key is required, or set LIVEKIT_API_KEY env var');
    if (this.opts.apiSecret === '')
      throw new Error('--api-secret is required, or set LIVEKIT_API_SECRET env var');

    const workerWS = async () => {
      // const retries = 0;
      while (!this.closed) {
        const token = new AccessToken(this.opts.apiKey, this.opts.apiSecret);
        token.addGrant({ agent: true });
        const jwt = await token.toJwt();

        const url = new URL(this.opts.wsURL);
        url.protocol = url.protocol.replace('http', 'ws');
        this.session = new WebSocket(url + 'agent', {
          headers: { authorization: 'Bearer ' + jwt },
        });
        this.session.on('open', () => {
          this.session!.removeAllListeners('close');
          this.runWS(this.session!);
        });
        return;

        // TODO(nbsp): retries that actually work
        // if (this.session.readyState !== WebSocket.OPEN) {
        //   if (this.closed) return;
        //   if (retries >= this.opts.maxRetry) {
        //     throw new Error(`failed to connect to LiveKit server after ${retries} attempts: ${e}`);
        //   }

        //   const delay = Math.min(retries * 2, 10);
        //   retries++;

        //   this.logger.warn(
        //     `failed to connect to LiveKit server, retrying in ${delay} seconds: ${e} (${retries}/${this.opts.maxRetry})`,
        //   );
        //   await new Promise((resolve) => setTimeout(resolve, delay));
        // }
      }
    };

    await Promise.all([workerWS(), this.httpServer.run()]);
  }

  startProcess(job: Job, url: string, token: string, acceptData: AcceptData) {
    const proc = new JobProcess(job, url, token, acceptData.entry);
    this.processes[job.id] = { proc, activeJob: new ActiveJob(job, acceptData) };
    new Promise((_, reject) => {
      try {
        proc.run();
      } catch (e) {
        proc.logger.error(`error running job process ${proc.job.id}`);
        reject(e);
      } finally {
        delete this.processes[job.id];
      }
    });
  }

  runWS(ws: WebSocket) {
    let closingWS = false;

    const send = (msg: WorkerMessage) => {
      if (closingWS) {
        this.event.off('worker_msg', send);
        return;
      }
      ws.send(msg.toBinary());
    };
    this.event.on('worker_msg', send);

    ws.addEventListener('close', () => {
      closingWS = true;
      if (!this.closed) throw new Error('worker connection closed unexpectedly');
    });

    ws.addEventListener('message', (event) => {
      if (event.type !== 'message') {
        this.logger.warn('unexpected message type: ' + event.type);
        return;
      }

      const msg = new ServerMessage();
      msg.fromBinary(event.data as Uint8Array);
      switch (msg.message.case) {
        case 'register': {
          this.#id = msg.message.value.workerId;
          log
            .child({ id: this.id, server_info: msg.message.value.serverInfo })
            .info('registered worker');
          break;
        }
        case 'availability': {
          const tx = new EventEmitter();
          const req = new JobRequest(msg.message.value.job!, tx);
          this.event.on('recv', (av: AvailRes) => {
            const msg = new WorkerMessage({
              message: {
                case: 'availability',
                value: {
                  available: av.avail,
                  jobId: req.id,
                  participantIdentity: av.data?.identity,
                  participantName: av.data?.name,
                  participantMetadata: av.data?.metadata,
                },
              },
            });

            this.pending[req.id] = { value: undefined };
            this.event.emit('worker_msg', msg);

            new Promise((_, reject) => {
              const timer = setTimeout(() => {
                reject(new Error(`assignment for job ${req.id} timed out`));
              }, ASSIGNMENT_TIMEOUT);
              Promise.resolve(this.pending[req.id].value).then((value) => {
                clearTimeout(timer);
                const url = value?.url || this.opts.wsURL;

                try {
                  this.opts.requestFunc(req);
                } catch (e) {
                  log.child({ req }).error(`user request hadnler for job ${req.id} failed`);
                } finally {
                  if (!req.answered) {
                    log
                      .child({ req })
                      .error(`no answer for job ${req.id}, automatically rejecting the job`);
                    this.event.emit(
                      'worker_msg',
                      new WorkerMessage({
                        message: {
                          case: 'availability',
                          value: {
                            available: false,
                          },
                        },
                      }),
                    );
                  }
                }

                this.startProcess(value!.job!, url, value!.token, av.data!);
              });
            });
          });

          break;
        }
        case 'assignment': {
          const job = msg.message.value.job!;
          if (job.id in this.pending) {
            const task = this.pending[job.id];
            delete this.pending[job.id];
            task.value = msg.message.value;
          } else {
            log.child({ job }).warn('received assignment for unknown job ' + job.id);
          }
          break;
        }
      }
    });

    this.event.emit(
      'worker_msg',
      new WorkerMessage({
        message: {
          case: 'register',
          value: {
            type: this.opts.workerType,
            namespace: this.opts.namespace,
            allowedPermissions: new ParticipantPermission({
              canPublish: this.opts.permissions.canPublish,
              canSubscribe: this.opts.permissions.canSubscribe,
              canPublishData: this.opts.permissions.canPublishData,
              hidden: this.opts.permissions.hidden,
              agent: true,
            }),
            version,
          },
        },
      }),
    );

    const loadMonitor = setInterval(() => {
      if (closingWS) clearInterval(loadMonitor);
      this.event.emit(
        'worker_msg',
        new WorkerMessage({
          message: {
            case: 'updateWorker',
            value: {
              load: cpuLoad(),
            },
          },
        }),
      );
    }, LOAD_INTERVAL);
  }

  async close() {
    if (this.closed) return;
    this.logger.info('shutting down worker');
    await this.httpServer.close();
    this.session;
  }
}
