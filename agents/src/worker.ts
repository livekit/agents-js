// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  JobAssignment,
  JobTermination,
  ParticipantInfo,
  TrackSource,
} from '@livekit/protocol';
import {
  type AvailabilityRequest,
  JobType,
  ParticipantPermission,
  ServerMessage,
  WorkerMessage,
  WorkerStatus,
} from '@livekit/protocol';
import { EventEmitter } from 'events';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import os from 'os';
import { WebSocket } from 'ws';
import { HTTPServer } from './http_server.js';
import { ProcPool } from './ipc/proc_pool.js';
import type { JobAcceptArguments, JobProcess, RunningJobInfo } from './job.js';
import { JobRequest } from './job.js';
import { log } from './log.js';
import { Future } from './utils.js';
import { version } from './version.js';

const MAX_RECONNECT_ATTEMPTS = 10;
const ASSIGNMENT_TIMEOUT = 7.5 * 1000;
const UPDATE_LOAD_INTERVAL = 2.5 * 1000;

export const defaultInitializeProcessFunc = (_: JobProcess) => _;
const defaultRequestFunc = async (ctx: JobRequest) => {
  await ctx.accept();
};

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
    this.canPublishSources = canPublishSources;
    this.hidden = hidden;
  }
}

export class WorkerOptions {
  agent: string;
  requestFunc: (job: JobRequest) => Promise<void>;
  loadFunc: () => number;
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
    agent,
    requestFunc = defaultRequestFunc,
    loadFunc = defaultCpuLoad,
    loadThreshold = 0.65,
    numIdleProcesses = 3,
    shutdownProcessTimeout = 60 * 1000,
    initializeProcessTimeout = 10 * 1000,
    permissions = new WorkerPermissions(),
    agentName = '',
    workerType = JobType.JT_ROOM,
    maxRetry = MAX_RECONNECT_ATTEMPTS,
    wsURL = 'ws://localhost:7880',
    apiKey = undefined,
    apiSecret = undefined,
    host = 'localhost',
    port = 8081,
    logLevel = 'info',
  }: {
    /** Path to a file that has Agent as a default export, dynamically imported later for entrypoint and prewarm functions */
    agent: string;
    requestFunc?: (job: JobRequest) => Promise<void>;
    /** Called to determine the current load of the worker. Should return a value between 0 and 1. */
    loadFunc?: () => number;
    /** When the load exceeds this threshold, the worker will be marked as unavailable. */
    loadThreshold?: number;
    numIdleProcesses?: number;
    shutdownProcessTimeout?: number;
    initializeProcessTimeout?: number;
    permissions?: WorkerPermissions;
    agentName?: string;
    workerType?: JobType;
    maxRetry?: number;
    wsURL?: string;
    apiKey?: string;
    apiSecret?: string;
    host?: string;
    port?: number;
    logLevel?: string;
  }) {
    this.agent = agent;
    this.requestFunc = requestFunc;
    this.loadFunc = loadFunc;
    this.loadThreshold = loadThreshold;
    this.numIdleProcesses = numIdleProcesses;
    this.shutdownProcessTimeout = shutdownProcessTimeout;
    this.initializeProcessTimeout = initializeProcessTimeout;
    this.permissions = permissions;
    this.agentName = agentName;
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

class PendingAssignment {
  promise = new Promise<JobAssignment>((resolve) => {
    this.resolve = resolve; // this is how JavaScript lets you resolve promises externally
  });
  resolve(arg: JobAssignment) {
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
  #tasks: Promise<void>[] = [];
  #pending: { [id: string]: PendingAssignment } = {};
  #close = new Future();

  event = new EventEmitter();
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
      opts.agent,
      opts.numIdleProcesses,
      opts.initializeProcessTimeout,
      opts.shutdownProcessTimeout,
    );

    this.#opts = opts;
    this.#httpServer = new HTTPServer(opts.host, opts.port);
  }

  async run() {
    if (!this.#closed) {
      throw new Error('worker is already running');
    }

    this.#logger.info('starting worker');
    this.#closed = false;
    this.#procPool.start();

    const workerWS = async () => {
      let retries = 0;
      this.#connecting = true;

      while (!this.#closed) {
        const url = new URL(this.#opts.wsURL);
        url.protocol = url.protocol.replace('http', 'ws');
        const token = new AccessToken(this.#opts.apiKey, this.#opts.apiSecret);
        token.addGrant({ agent: true });
        const jwt = await token.toJwt();
        this.#session = new WebSocket(url + 'agent', {
          headers: { authorization: 'Bearer ' + jwt },
        });

        try {
          await new Promise((resolve, reject) => {
            this.#session!.on('open', resolve);
            this.#session!.on('error', (error) => reject(error));
            this.#session!.on('close', (code) => reject(`WebSocket returned ${code}`));
          });

          retries = 0;
          this.#logger.debug('connected to LiveKit server');
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
    };

    await Promise.all([workerWS(), this.#httpServer.run()]);
    this.#close.resolve();
  }

  get id(): string {
    return this.#id;
  }

  get activeJobs(): RunningJobInfo[] {
    return this.#procPool.processes
      .filter((proc) => proc.runningJob)
      .map((proc) => proc.runningJob!);
  }

  async drain(timeout?: number) {
    if (this.#draining) {
      return;
    }

    this.#logger.info('draining worker');
    this.#draining = true;

    this.event.emit(
      'worker_msg',
      new WorkerMessage({
        message: {
          case: 'updateWorker',
          value: {
            status: WorkerStatus.WS_FULL,
          },
        },
      }),
    );

    const joinJobs = async () => {
      for (const proc of this.#procPool.processes) {
        if (proc.runningJob) {
          await proc.join();
        }
      }
    };

    const timer = setTimeout(() => {
      throw new Error('timed out draining');
    }, timeout);
    if (timeout === undefined) clearTimeout(timer);
    await joinJobs().then(() => {
      clearTimeout(timer);
    });
  }

  async simulateJob(roomName: string, participantIdentity?: string) {
    const client = new RoomServiceClient(this.#opts.wsURL);
    const room = await client.createRoom({ name: roomName });
    let participant: ParticipantInfo | undefined = undefined;
    if (participantIdentity) {
      participant = await client.getParticipant(roomName, participantIdentity);
    }

    this.event!.emit(
      'worker_msg',
      new WorkerMessage({
        message: {
          case: 'simulateJob',
          value: {
            type: JobType.JT_PUBLISHER,
            room,
            participant,
          },
        },
      }),
    );
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

      // register is the only valid first message, and it is only valid as the
      // first message
      if (this.#connecting && msg.message.case !== 'register') {
        throw new Error('expected register response as first message');
      }

      switch (msg.message.case) {
        case 'register': {
          this.#id = msg.message.value.workerId;
          log()
            .child({ id: this.id, server_info: msg.message.value.serverInfo })
            .info('registered worker');
          this.event.emit(
            'worker_registered',
            msg.message.value.workerId,
            msg.message.value.serverInfo!,
          );
          this.#connecting = false;
          break;
        }
        case 'availability': {
          const task = this.availability(msg.message.value);
          this.#tasks.push(task);
          task.finally(() => this.#tasks.splice(this.#tasks.indexOf(task)));
          break;
        }
        case 'assignment': {
          const job = msg.message.value.job!;
          if (job.id in this.#pending) {
            const task = this.#pending[job.id];
            delete this.#pending[job.id];
            task.resolve(msg.message.value);
          } else {
            log()
              .child({ job })
              .warn('received assignment for unknown job ' + job.id);
          }
          break;
        }
        case 'termination': {
          const task = this.termination(msg.message.value);
          this.#tasks.push(task);
          task.finally(() => this.#tasks.splice(this.#tasks.indexOf(task)));
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
            type: this.#opts.workerType,
            agentName: this.#opts.agentName,
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

      this.event.emit(
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
    }, UPDATE_LOAD_INTERVAL);
  }

  async availability(msg: AvailabilityRequest) {
    let answered = false;

    const onReject = async () => {
      answered = true;
      this.event.emit(
        'worker_msg',
        new WorkerMessage({
          message: {
            case: 'availability',
            value: {
              jobId: msg.job!.id,
              available: false,
            },
          },
        }),
      );
    };

    const onAccept = async (args: JobAcceptArguments) => {
      answered = true;

      this.event.emit(
        'worker_msg',
        new WorkerMessage({
          message: {
            case: 'availability',
            value: {
              jobId: msg.job!.id,
              available: true,
              participantIdentity: args.identity,
              participantName: args.name,
              participantMetadata: args.metadata,
            },
          },
        }),
      );

      this.#pending[req.id] = new PendingAssignment();
      const timer = setTimeout(() => {
        this.#logger.child({ req }).warn(`assignment for job ${req.id} timed out`);
        return;
      }, ASSIGNMENT_TIMEOUT);
      const asgn = await this.#pending[req.id].promise.then(async (asgn) => {
        clearTimeout(timer);
        return asgn;
      });

      await this.#procPool.launchJob({
        acceptArguments: args,
        job: msg.job!,
        url: asgn.url || this.#opts.wsURL,
        token: asgn.token,
      });
    };

    const req = new JobRequest(msg.job!, onReject, onAccept);
    this.#logger
      .child({ job: msg.job, resuming: msg.resuming, agentName: this.#opts.agentName })
      .info('received job request');

    const jobRequestTask = async () => {
      try {
        await this.#opts.requestFunc(req);
      } catch (e) {
        this.#logger
          .child({ job: msg.job, resuming: msg.resuming, agentName: this.#opts.agentName })
          .info('jobRequestFunc failed');
        await onReject();
      }

      if (!answered) {
        this.#logger
          .child({ job: msg.job, resuming: msg.resuming, agentName: this.#opts.agentName })
          .info('no answer was given inside the jobRequestFunc, automatically rejecting the job');
      }
    };

    const task = jobRequestTask();
    this.#tasks.push(task);
    task.finally(() => this.#tasks.splice(this.#tasks.indexOf(task)));
  }

  async termination(msg: JobTermination) {
    const proc = this.#procPool.getByJobId(msg.jobId);
    if (proc === null) {
      // safe to ignore
      return;
    }
    await proc.close();
  }

  async close() {
    if (this.#closed) {
      await this.#close.await;
      return;
    }

    this.#logger.info('shutting down worker');

    this.#closed = true;

    await this.#procPool.close();
    await this.#httpServer.close();
    await Promise.allSettled(this.#tasks);

    this.#session?.close();
    await this.#close.await;
  }
}
