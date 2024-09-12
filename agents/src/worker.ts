// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AvailabilityRequest,
  type Job,
  type JobAssignment,
  JobType,
  ParticipantPermission,
  ServerMessage,
  WorkerMessage,
  WorkerStatus,
} from '@livekit/protocol';
import { EventEmitter } from 'events';
import { AccessToken } from 'livekit-server-sdk';
import os from 'os';
import { WebSocket } from 'ws';
import { HTTPServer } from './http_server.js';
import { JobProcess } from './ipc/job_process.js';
import { type AvailRes, JobRequest } from './job_request.js';
import type { AcceptData } from './job_request.js';
import { log } from './log.js';
import { version } from './version.js';

const MAX_RECONNECT_ATTEMPTS = 10;
const ASSIGNMENT_TIMEOUT = 15 * 1000;
const LOAD_INTERVAL = 5 * 1000;

const defaultCpuLoad = (): number =>
  1 -
  os
    .cpus()
    .reduce(
      (acc, x) => acc + x.times.idle / Object.values(x.times).reduce((acc, x) => acc + x, 0),
      0,
    ) /
    os.cpus().length;

export class WorkerPermissions {
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
  loadFunc: () => number;
  loadThreshold: number;
  namespace: string;
  permissions: WorkerPermissions;
  workerType: JobType;
  maxRetry: number;
  wsURL: string;
  apiKey?: string;
  apiSecret?: string;
  host: string;
  port: number;
  logLevel: string;

  constructor({
    requestFunc,
    loadFunc = defaultCpuLoad,
    loadThreshold = 0.65,
    namespace = 'default',
    permissions = new WorkerPermissions(),
    workerType = JobType.JT_ROOM,
    maxRetry = MAX_RECONNECT_ATTEMPTS,
    wsURL = 'ws://localhost:7880',
    apiKey = undefined,
    apiSecret = undefined,
    host = 'localhost',
    port = 8081,
    logLevel = 'info',
  }: {
    requestFunc: (arg: JobRequest) => Promise<void>;
    /** Called to determine the current load of the worker. Should return a value between 0 and 1. */
    loadFunc?: () => number;
    /** When the load exceeds this threshold, the worker will be marked as unavailable. */
    loadThreshold?: number;
    namespace?: string;
    permissions?: WorkerPermissions;
    workerType?: JobType;
    maxRetry?: number;
    wsURL?: string;
    apiKey?: string;
    apiSecret?: string;
    host?: string;
    port?: number;
    logLevel?: string;
  }) {
    this.requestFunc = requestFunc;
    this.loadFunc = loadFunc;
    this.loadThreshold = loadThreshold;
    this.namespace = namespace;
    this.permissions = permissions;
    this.workerType = workerType;
    this.maxRetry = maxRetry;
    this.wsURL = wsURL;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.host = host;
    this.port = port;
    this.logLevel = logLevel;
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

type AssignmentPair = {
  // this string is the JSON string version of the JobAssignment.
  // we keep it around to unpack it again in the child, because we can't pass Job directly.
  raw: string;
  asgn: JobAssignment;
};

class PendingAssignment {
  promise = new Promise<AssignmentPair>((resolve) => {
    this.resolve = resolve; // this is how JavaScript lets you resolve promises externally
  });
  resolve(arg: AssignmentPair) {
    arg; // useless call to counteract TypeScript E6133
  }
}

export class Worker {
  #opts: WorkerOptions;
  #id = 'unregistered';
  #session: WebSocket | undefined = undefined;
  #closed = false;
  #httpServer: HTTPServer;
  #logger = log().child({ version });
  #event = new EventEmitter();
  #pending: { [id: string]: { value: PendingAssignment } } = {};
  #processes: { [id: string]: { proc: JobProcess; activeJob: ActiveJob } } = {};

  constructor(opts: WorkerOptions) {
    opts.wsURL = opts.wsURL || process.env.LIVEKIT_URL || '';
    opts.apiKey = opts.apiKey || process.env.LIVEKIT_API_KEY || '';
    opts.apiSecret = opts.apiSecret || process.env.LIVEKIT_API_SECRET || '';

    this.#opts = opts;
    this.#httpServer = new HTTPServer(opts.host, opts.port);
  }

  get id(): string {
    return this.#id;
  }

  async run() {
    this.#logger.info('starting worker');

    if (this.#opts.wsURL === '') throw new Error('--url is required, or set LIVEKIT_URL env var');
    if (this.#opts.apiKey === '')
      throw new Error('--api-key is required, or set LIVEKIT_API_KEY env var');
    if (this.#opts.apiSecret === '')
      throw new Error('--api-secret is required, or set LIVEKIT_API_SECRET env var');

    const workerWS = async () => {
      let retries = 0;
      while (!this.#closed) {
        const token = new AccessToken(this.#opts.apiKey, this.#opts.apiSecret);
        token.addGrant({ agent: true });
        const jwt = await token.toJwt();

        const url = new URL(this.#opts.wsURL);
        url.protocol = url.protocol.replace('http', 'ws');
        this.#session = new WebSocket(url + 'agent', {
          headers: { authorization: 'Bearer ' + jwt },
        });

        try {
          await new Promise((resolve, reject) => {
            this.#session!.on('open', resolve);
            this.#session!.on('error', (error) => reject(error));
            this.#session!.on('close', (code) => reject(`WebSocket returned ${code}`));
          });

          this.runWS(this.#session!);
          return;
        } catch (e) {
          if (this.#closed) return;
          if (retries >= this.#opts.maxRetry) {
            throw new Error(`failed to connect to LiveKit server after ${retries} attempts: ${e}`);
          }

          retries++;
          const delay = Math.min(retries * 2, 10);

          this.#logger.warn(
            `failed to connect to LiveKit server, retrying in ${delay} seconds: ${e} (${retries}/${this.#opts.maxRetry})`,
          );

          await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        }
      }
    };

    await Promise.all([workerWS(), this.#httpServer.run()]);
  }

  startProcess(job: Job, acceptData: AcceptData, raw: string) {
    const proc = new JobProcess(job, acceptData, raw, this.#opts.wsURL);
    this.#processes[job.id] = { proc, activeJob: new ActiveJob(job, acceptData) };
    proc
      .run()
      .catch((e) => {
        proc.logger.error(`error running job process ${proc.job.id}: ${e}`);
      })
      .finally(() => {
        proc.clear();
        delete this.#processes[job.id];
      });
  }

  runWS(ws: WebSocket) {
    let closingWS = false;

    const send = (msg: WorkerMessage) => {
      if (closingWS) {
        this.#event.off('worker_msg', send);
        return;
      }
      ws.send(msg.toBinary());
    };
    this.#event.on('worker_msg', send);

    ws.addEventListener('close', () => {
      closingWS = true;
      this.#logger.error('worker connection closed unexpectedly');
      this.close();
    });

    ws.addEventListener('message', (event) => {
      if (event.type !== 'message') {
        this.#logger.warn('unexpected message type: ' + event.type);
        return;
      }

      const msg = new ServerMessage();
      msg.fromBinary(event.data as Uint8Array);
      switch (msg.message.case) {
        case 'register': {
          this.#id = msg.message.value.workerId;
          log()
            .child({ id: this.id, server_info: msg.message.value.serverInfo })
            .info('registered worker');
          break;
        }
        case 'availability': {
          this.availability(msg.message.value);
          break;
        }
        case 'assignment': {
          const job = msg.message.value.job!;
          if (job.id in this.#pending) {
            const task = this.#pending[job.id];
            delete this.#pending[job.id];
            task.value.resolve({
              asgn: msg.message.value,
              raw: msg.toJsonString(),
            });
          } else {
            log()
              .child({ job })
              .warn('received assignment for unknown job ' + job.id);
          }
          break;
        }
      }
    });

    this.#event.emit(
      'worker_msg',
      new WorkerMessage({
        message: {
          case: 'register',
          value: {
            type: this.#opts.workerType,
            namespace: this.#opts.namespace,
            allowedPermissions: new ParticipantPermission({
              canPublish: this.#opts.permissions.canPublish,
              canSubscribe: this.#opts.permissions.canSubscribe,
              canPublishData: this.#opts.permissions.canPublishData,
              hidden: this.#opts.permissions.hidden,
              agent: true,
            }),
            version,
          },
        },
      }),
    );

    let currentStatus = WorkerStatus.WS_AVAILABLE;
    const loadMonitor = setInterval(() => {
      if (closingWS) clearInterval(loadMonitor);

      const oldStatus = currentStatus;
      const currentLoad = this.#opts.loadFunc();
      const isFull = currentLoad >= this.#opts.loadThreshold;
      const currentlyAvailable = !isFull;
      currentStatus = currentlyAvailable ? WorkerStatus.WS_AVAILABLE : WorkerStatus.WS_FULL;

      if (oldStatus != currentStatus) {
        const extra = { load: currentLoad, loadThreshold: this.#opts.loadThreshold };
        if (isFull) {
          log().child(extra).info('worker is at full capacity, marking as unavailable');
        } else {
          log().child(extra).info('worker is below capacity, marking as available');
        }
      }

      this.#event.emit(
        'worker_msg',
        new WorkerMessage({
          message: {
            case: 'updateWorker',
            value: {
              load: currentLoad,
              status: currentStatus,
            },
          },
        }),
      );
    }, LOAD_INTERVAL);
  }

  async availability(msg: AvailabilityRequest) {
    const tx = new EventEmitter();
    const req = new JobRequest(msg.job!, tx);

    tx.on('recv', async (av: AvailRes) => {
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

      this.#pending[req.id] = { value: new PendingAssignment() };
      this.#event.emit('worker_msg', msg);
      if (!av.avail) return;

      const timer = setTimeout(() => {
        log().child({ req }).warn(`assignment for job ${req.id} timed out`);
        return;
      }, ASSIGNMENT_TIMEOUT);
      this.#pending[req.id].value.promise.then(({ asgn, raw }) => {
        clearTimeout(timer);
        this.startProcess(asgn!.job!, av.data!, raw);
      });
    });

    try {
      this.#opts.requestFunc(req);
    } catch (e) {
      log().child({ req }).error(`user request handler for job ${req.id} failed`);
    } finally {
      if (!req.answered) {
        log().child({ req }).error(`no answer for job ${req.id}, automatically rejecting the job`);
        this.#event.emit(
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
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#logger.debug('shutting down worker');
    await this.#httpServer.close();
    for await (const value of Object.values(this.#processes)) {
      await value.proc.close();
    }
    this.#session?.close();
  }
}
