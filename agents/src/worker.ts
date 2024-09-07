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
  TrackSource,
} from '@livekit/protocol';
import { EventEmitter } from 'events';
import { AccessToken } from 'livekit-server-sdk';
import os from 'os';
import { WebSocket } from 'ws';
import { HTTPServer } from './http_server.js';
import { log } from './log.js';
import { version } from './version.js';
import { JobContext, JobExecutorType, JobProcess, JobRequest, RunningJobInfo } from './job.js';

const MAX_RECONNECT_ATTEMPTS = 10;
const ASSIGNMENT_TIMEOUT = 7.5 * 1000;
const UPDATE_LOAD_INTERVAL = 2.5 * 1000;

const defaultInitializeProcessFunc = (proc: JobProcess) => {};
const defaultRequestFunc = async (ctx: JobRequest) => { await ctx.accept() };

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
  canPublishSources: TrackSource[];
  hidden: boolean;

  constructor(
    canPublish = true,
    canSubscribe = true,
    canPublishData = true,
    canUpdateMetadata = true,
    canPublishSources: TrackSource[] = [],
    hidden = false,
  ) {
    this.canPublish = canPublish;
    this.canSubscribe = canSubscribe;
    this.canPublishData = canPublishData;
    this.canUpdateMetadata = canUpdateMetadata;
    this.canPublishSources = canPublishSources
    this.hidden = hidden;
  }
}

export class WorkerOptions {
  entrypointFunc: (ctx: JobContext) => Promise<void>;
  requestFunc: (job: JobRequest) => Promise<void>;
  prewarmFunc: (proc: JobProcess) => any;
  loadFunc: () => number;
  jobExecutorType: JobExecutorType;
  loadThreshold: number;
  numIdleProcesses: number;
  shutdownProcessTimeout: number;
  initializeProcessTimeout: number;
  permissions: WorkerPermissions;
  agentName: string;
  workerType: JobType;
  maxRetry: number;
  wsURL: string;
  apiKey?: string;
  apiSecret?: string;
  host: string;
  port: number;
  logLevel: string;

  constructor({
    entrypointFunc,
    requestFunc = defaultRequestFunc,
    prewarmFunc = defaultInitializeProcessFunc,
    loadFunc = defaultCpuLoad,
    jobExecutorType = JobExecutorType.PROCESS,
    loadThreshold = 0.65,
    numIdleProcesses = 3,
    shutdownProcessTimeout = 60,
    initializeProcessTimeout = 10,
    permissions = new WorkerPermissions(),
    agentName = "",
    workerType = JobType.JT_ROOM,
    maxRetry = MAX_RECONNECT_ATTEMPTS,
    wsURL = 'ws://localhost:7880',
    apiKey = undefined,
    apiSecret = undefined,
    host = 'localhost',
    port = 8081,
    logLevel = 'info',
  }: {
    entrypointFunc: (ctx: JobContext) => Promise<void>;
    requestFunc: (job: JobRequest) => Promise<void>;
    prewarmFunc: (proc: JobProcess) => any;
    /** Called to determine the current load of the worker. Should return a value between 0 and 1. */
    loadFunc?: () => number;
    jobExecutorType: JobExecutorType;
    /** When the load exceeds this threshold, the worker will be marked as unavailable. */
    loadThreshold?: number;
    numIdleProcesses: number;
    shutdownProcessTimeout: number;
    initializeProcessTimeout: number;
    permissions?: WorkerPermissions;
    agentName: string;
    workerType?: JobType;
    maxRetry?: number;
    wsURL?: string;
    apiKey?: string;
    apiSecret?: string;
    host?: string;
    port?: number;
    logLevel?: string;
  }) {
    this.entrypointFunc = entrypointFunc;
    this.requestFunc = requestFunc;
    this.prewarmFunc = prewarmFunc;
    this.loadFunc = loadFunc;
    this.jobExecutorType = jobExecutorType;
    this.loadThreshold = loadThreshold;
    this.numIdleProcesses = numIdleProcesses
    this.shutdownProcessTimeout = shutdownProcessTimeout
    this.initializeProcessTimeout = initializeProcessTimeout
    this.permissions = permissions;
    this.agentName = agentName
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
  #procPool: ProcPool;

  #id = 'unregistered';
  #closed = true;
  #draining = false;
  #connecting = false;
  #pending: { [id: string]: PendingAssignment } = {};

  #close = () => {};
  #closePromise = new Promise<void>((resolve) => {
    this.#close = resolve;
  });

  #event = new EventEmitter();
  #session: WebSocket | undefined = undefined;
  #httpServer: HTTPServer;
  #logger = log().child({ version });

  constructor(opts: WorkerOptions) {
    opts.wsURL = opts.wsURL || process.env.LIVEKIT_URL || '';
    opts.apiKey = opts.apiKey || process.env.LIVEKIT_API_KEY || '';
    opts.apiSecret = opts.apiSecret || process.env.LIVEKIT_API_SECRET || '';

    if (opts.wsURL === '') throw new Error('--url is required, or set LIVEKIT_URL env var');
    if (opts.apiKey === '')
      throw new Error('--api-key is required, or set LIVEKIT_API_KEY env var');
    if (opts.apiSecret === '')
      throw new Error('--api-secret is required, or set LIVEKIT_API_SECRET env var');

    this.#procPool = new ProcPool(
      opts.prewarmFunc,
      opts.entrypointFunc,
      opts.numIdleProcesses,
      opts.jobExecutorType,
      opts.initializeProcessTimeout,
      opts.shutdownProcessTimeout,
    );

    this.#opts = opts;
    this.#httpServer = new HTTPServer(opts.host, opts.port);
  }

  async run() {
    if (!this.#closed) {
      throw new Error("worker is already running")
    }

    this.#logger.info("starting worker")
    this.#closed = false
    this.#procPool.start()

    const workerWS = async () => {
      let retries = 0;

      while (!this.#closed) {
        const url = new URL(this.#opts.wsURL);
        url.protocol = url.protocol.replace('http', 'ws');
        const token = new AccessToken(this.#opts.apiKey, this.#opts.apiSecret);
        token.addGrant({ agent: true });
        const jwt = await token.toJwt();
        this.#session = new WebSocket(url + 'agent', {
          headers: { authorization: 'Bearer ' + jwt },
        })

        try {
          await new Promise((resolve, reject) => {
            this.#session!.on('open', resolve);
            this.#session!.on('error', (error) => reject(error));
            this.#session!.on('close', (code) => reject(`WebSocket returned ${code}`));
          });

          retries = 0;
          this.runWS(this.#session);
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
    }

    await Promise.all([workerWS(), this.#httpServer.run()]);
    this.#close();
  }

  get id(): string {
    return this.#id;
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
