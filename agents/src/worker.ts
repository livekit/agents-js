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
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { EventEmitter } from 'node:events';
import os from 'node:os';
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

class Default {
  static loadThreshold(production: boolean): number {
    if (production) {
      return 0.65;
    } else {
      return Infinity;
    }
  }

  static numIdleProcesses(production: boolean): number {
    if (production) {
      return 3;
    } else {
      return 0;
    }
  }

  static port(production: boolean): number {
    if (production) {
      return 8081;
    } else {
      return 0;
    }
  }
}

/** Necessary credentials not provided and not found in an appropriate environmental variable. */
export class MissingCredentialsError extends Error {
  constructor(msg?: string) {
    super(msg);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Worker did not run as expected. */
export class WorkerError extends Error {
  constructor(msg?: string) {
    super(msg);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @internal */
export const defaultInitializeProcessFunc = (_: JobProcess) => _;
const defaultRequestFunc = async (ctx: JobRequest) => {
  await ctx.accept();
};
const defaultCpuLoad = async (): Promise<number> => {
  return new Promise((resolve) => {
    const cpus1 = os.cpus();

    setTimeout(() => {
      const cpus2 = os.cpus();

      let idle = 0;
      let total = 0;

      for (let i = 0; i < cpus1.length; i++) {
        const cpu1 = cpus1[i]!.times;
        const cpu2 = cpus2[i]!.times;

        idle += cpu2.idle - cpu1.idle;

        const total1 = Object.values(cpu1).reduce((acc, i) => acc + i, 0);
        const total2 = Object.values(cpu2).reduce((acc, i) => acc + i, 0);

        total += total2 - total1;
      }

      resolve(+(1 - idle / total).toFixed(2));
    }, UPDATE_LOAD_INTERVAL);
  });
};

/** Participant permissions to pass to every agent spun up by this worker. */
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

/**
 * Data class describing worker behaviour.
 *
 * @remarks
 * The Agents framework provides sane worker defaults, and works out-of-the-box with no tweaking
 * necessary. The only mandatory parameter is `agent`, which points to the entry function.
 *
 * This class is mostly useful in conjunction with {@link cli.runApp}.
 */
export class WorkerOptions {
  agent: string;
  requestFunc: (job: JobRequest) => Promise<void>;
  loadFunc: () => Promise<number>;
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
  production: boolean;

  /** @param options */
  constructor({
    agent,
    requestFunc = defaultRequestFunc,
    loadFunc = defaultCpuLoad,
    loadThreshold = undefined,
    numIdleProcesses = undefined,
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
    port = undefined,
    logLevel = 'info',
    production = false,
  }: {
    /**
     * Path to a file that has {@link Agent} as a default export, dynamically imported later for
     * entrypoint and prewarm functions
     */
    agent: string;
    requestFunc?: (job: JobRequest) => Promise<void>;
    /** Called to determine the current load of the worker. Should return a value between 0 and 1. */
    loadFunc?: () => Promise<number>;
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
    production?: boolean;
  }) {
    this.agent = agent;
    if (!this.agent) {
      throw new Error('No Agent file was passed to the worker');
    }
    this.requestFunc = requestFunc;
    this.loadFunc = loadFunc;
    this.loadThreshold = loadThreshold || Default.loadThreshold(production);
    this.numIdleProcesses = numIdleProcesses || Default.numIdleProcesses(production);
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
    this.port = port || Default.port(production);
    this.logLevel = logLevel;
    this.production = production;
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

/**
 * Central orchestrator for all processes and job requests.
 *
 * @remarks
 * For most usecases, Worker should not be initialized or handled directly; you should instead call
 * for its creation through {@link cli.runApp}. This could, however, be useful in situations where
 * you don't have access to a command line, such as a headless program, or one that uses Agents
 * behind a wrapper.
 */
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

  /* @throws {@link MissingCredentialsError} if URL, API key or API secret are missing */
  constructor(opts: WorkerOptions) {
    opts.wsURL = opts.wsURL || process.env.LIVEKIT_URL || '';
    opts.apiKey = opts.apiKey || process.env.LIVEKIT_API_KEY || '';
    opts.apiSecret = opts.apiSecret || process.env.LIVEKIT_API_SECRET || '';

    if (opts.wsURL === '')
      throw new MissingCredentialsError(
        'URL is required: Set LIVEKIT_URL, run with --url, or pass wsURL in WorkerOptions',
      );
    if (opts.apiKey === '')
      throw new MissingCredentialsError(
        'API Key is required: Set LIVEKIT_API_KEY, run with --api-key, or pass apiKey in WorkerOptions',
      );
    if (opts.apiSecret === '')
      throw new MissingCredentialsError(
        'API Secret is required: Set LIVEKIT_API_SECRET, run with --api-secret, or pass apiSecret in WorkerOptions',
      );

    this.#procPool = new ProcPool(
      opts.agent,
      opts.numIdleProcesses,
      opts.initializeProcessTimeout,
      opts.shutdownProcessTimeout,
    );

    this.#opts = opts;
    this.#httpServer = new HTTPServer(opts.host, opts.port);
  }

  /* @throws {@link WorkerError} if worker failed to connect or already running */
  async run() {
    if (!this.#closed) {
      throw new WorkerError('worker is already running');
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
            this.#session!.on('close', (code) => reject(new Error(`WebSocket returned ${code}`)));
          });

          retries = 0;
          this.#logger.debug('connected to LiveKit server');
          this.#runWS(this.#session);
          return;
        } catch (e) {
          if (this.#closed) return;
          if (retries >= this.#opts.maxRetry) {
            throw new WorkerError(
              `failed to connect to LiveKit server after ${retries} attempts: ${e}`,
            );
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

  /* @throws {@link WorkerError} if worker did not drain in time */
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
      return Promise.all(
        this.#procPool.processes.map((proc) => {
          if (!proc.runningJob) {
            proc.close();
          }
          return proc.join();
        }),
      );
    };

    const timer = setTimeout(() => {
      throw new WorkerError('timed out draining');
    }, timeout);
    if (timeout === undefined) clearTimeout(timer);
    await joinJobs().then(() => {
      clearTimeout(timer);
    });
  }

  async simulateJob(roomName: string, participantIdentity?: string) {
    const client = new RoomServiceClient(this.#opts.wsURL, this.#opts.apiKey, this.#opts.apiSecret);
    const room = await client.createRoom({ name: roomName });
    let participant: ParticipantInfo | undefined = undefined;
    if (participantIdentity) {
      try {
        participant = await client.getParticipant(roomName, participantIdentity);
      } catch (e) {
        this.#logger.fatal(
          `participant with identity ${participantIdentity} not found in room ${roomName}`,
        );
        throw e;
      }
    }

    this.event.emit(
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

  #runWS(ws: WebSocket) {
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
        throw new WorkerError('expected register response as first message');
      }

      switch (msg.message.case) {
        case 'register': {
          this.#id = msg.message.value.workerId;
          this.#logger
            .child({ id: this.id, server_info: msg.message.value.serverInfo })
            .info('registered worker');
          this.event.emit(
            'worker_registered',
            msg.message.value.workerId,
            msg.message.value.serverInfo,
          );
          this.#connecting = false;
          break;
        }
        case 'availability': {
          if (!msg.message.value.job) return;
          const task = this.#availability(msg.message.value);
          this.#tasks.push(task);
          task.finally(() => this.#tasks.splice(this.#tasks.indexOf(task)));
          break;
        }
        case 'assignment': {
          if (!msg.message.value.job) return;
          const job = msg.message.value.job;
          if (job.id in this.#pending) {
            const task = this.#pending[job.id];
            delete this.#pending[job.id];
            task?.resolve(msg.message.value);
          } else {
            this.#logger.child({ job }).warn('received assignment for unknown job ' + job.id);
          }
          break;
        }
        case 'termination': {
          const task = this.#termination(msg.message.value);
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
              canUpdateMetadata: this.#opts.permissions.canUpdateMetadata,
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
      this.#opts.loadFunc().then((currentLoad: number) => {
        const isFull = currentLoad >= this.#opts.loadThreshold;
        const currentlyAvailable = !isFull;
        currentStatus = currentlyAvailable ? WorkerStatus.WS_AVAILABLE : WorkerStatus.WS_FULL;

        if (oldStatus != currentStatus) {
          const extra = { load: currentLoad, loadThreshold: this.#opts.loadThreshold };
          if (isFull) {
            this.#logger.child(extra).info('worker is at full capacity, marking as unavailable');
          } else {
            this.#logger.child(extra).info('worker is below capacity, marking as available');
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
      });
    }, UPDATE_LOAD_INTERVAL);
  }

  async #availability(msg: AvailabilityRequest) {
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
              participantAttributes: args.attributes,
            },
          },
        }),
      );

      this.#pending[req.id] = new PendingAssignment();
      const timer = setTimeout(() => {
        this.#logger.child({ req }).warn(`assignment for job ${req.id} timed out`);
        return;
      }, ASSIGNMENT_TIMEOUT);
      const asgn = await this.#pending[req.id]?.promise.then(async (asgn) => {
        clearTimeout(timer);
        return asgn;
      });

      if (asgn) {
        await this.#procPool.launchJob({
          acceptArguments: args,
          job: msg.job!,
          url: asgn.url || this.#opts.wsURL,
          token: asgn.token,
        });
      } else {
        this.#logger.child({ requestId: req.id }).warn('pending assignment not found');
      }
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

  async #termination(msg: JobTermination) {
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
