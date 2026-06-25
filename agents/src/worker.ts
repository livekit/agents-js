// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JobAssignment, JobTermination, TrackSource } from '@livekit/protocol';
import {
  type AvailabilityRequest,
  JobType,
  ParticipantPermission,
  ServerMessage,
  WorkerMessage,
  WorkerStatus,
} from '@livekit/protocol';
import { type Throws, ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { ParticipantInfo } from 'livekit-server-sdk';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { EventEmitter } from 'node:events';
import { availableParallelism } from 'node:os';
import { extname } from 'node:path';
import { WebSocket } from 'ws';
import { APIStatusError } from './_exceptions.js';
import { ATTRIBUTE_AGENT_NAME } from './constants.js';
import { getCpuMonitor } from './cpu.js';
import { HTTPServer } from './http_server.js';
import { _getLocalInferenceModule } from './inference/_warmup.js';
import { EOT_INFERENCE_METHOD } from './inference/eot/runner.js';
import { InferenceRunner } from './inference_runner.js';
import { InferenceProcExecutor } from './ipc/inference_proc_executor.js';
import { ProcPool } from './ipc/proc_pool.js';
import type { JobAcceptArguments, JobProcess, RunningJobInfo } from './job.js';
import { JobRequest } from './job.js';
import { log } from './log.js';
import { Future, rejectOnAbort } from './utils.js';
import { version } from './version.js';

const MAX_RECONNECT_ATTEMPTS = 10;
const ASSIGNMENT_TIMEOUT = 7.5 * 1000;
const UPDATE_LOAD_INTERVAL = 2.5 * 1000;
const PROJECT_TYPE = 'nodejs';

let localEotRunnerRegistered = false;
/**
 * Register the local audio-EOT inference runner so it runs in the shared
 * inference process. Idempotent and guarded by native-binding availability;
 * a no-op (with a one-time warning) when `@livekit/local-inference` can't be
 * loaded so the worker still starts on unsupported platforms.
 */
function maybeRegisterLocalEotRunner(): void {
  if (localEotRunnerRegistered) return;
  localEotRunnerRegistered = true;
  if (InferenceRunner.registeredRunners[EOT_INFERENCE_METHOD]) return;
  if (_getLocalInferenceModule() === undefined) {
    log().warn(
      '@livekit/local-inference native binding unavailable; local audio EOT disabled ' +
        '(predictions will degrade to a positive default). cloud EOT and other turn ' +
        'detection modes are unaffected.',
    );
    return;
  }
  const ext = extname(import.meta.url); // '.js' (built) or '.ts' (tsx/ts-node)
  InferenceRunner.registerRunner(
    EOT_INFERENCE_METHOD,
    new URL(`./inference/eot/runner${ext}`, import.meta.url).toString(),
  );
}

class Default {
  static loadThreshold(production: boolean): number {
    if (production) {
      return 0.7;
    } else {
      return Infinity;
    }
  }

  static numIdleProcesses(production: boolean): number {
    if (production) {
      return Math.min(availableParallelism(), 4);
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

/** Necessary credentials not provided and not found in an appropriate environment variable. */
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

const cpuMonitor = getCpuMonitor();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const defaultCpuLoad = async (_worker: AgentServer): Promise<number> => {
  return cpuMonitor.cpuPercent(UPDATE_LOAD_INTERVAL);
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
export class ServerOptions {
  agent: string;
  requestFunc: (job: JobRequest) => Promise<void>;
  loadFunc: (worker: AgentServer) => Promise<number>;
  loadThreshold: number;
  numIdleProcesses: number;
  shutdownProcessTimeout: number;
  initializeProcessTimeout: number;
  permissions: WorkerPermissions;
  agentName: string;
  agentNameIsEnv: boolean;
  serverType: JobType;
  maxRetry: number;
  wsURL: string;
  apiKey?: string;
  apiSecret?: string;
  workerToken?: string;
  host: string;
  port: number;
  logLevel: string;
  production: boolean;
  simulation: boolean;
  jobMemoryWarnMB: number;
  jobMemoryLimitMB: number;

  /** @param options - Worker options */
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
    agentNameIsEnv = undefined,
    serverType = JobType.JT_ROOM,
    maxRetry = MAX_RECONNECT_ATTEMPTS,
    wsURL = 'ws://localhost:7880',
    apiKey = undefined,
    apiSecret = undefined,
    workerToken = undefined,
    host = '0.0.0.0',
    port = undefined,
    logLevel = 'info',
    production = false,
    simulation = false,
    jobMemoryWarnMB = 1000,
    jobMemoryLimitMB = 0,
  }: {
    /**
     * Path to a file that has {@link Agent} as a default export, dynamically imported later for
     * entrypoint and prewarm functions
     */
    agent: string;
    requestFunc?: (job: JobRequest) => Promise<void>;
    /** Called to determine the current load of the worker. Should return a value between 0 and 1. */
    loadFunc?: (worker: AgentServer) => Promise<number>;
    /** When the load exceeds this threshold, the worker will be marked as unavailable. */
    loadThreshold?: number;
    numIdleProcesses?: number;
    shutdownProcessTimeout?: number;
    initializeProcessTimeout?: number;
    permissions?: WorkerPermissions;
    /**
     * Set agentName to enable explicit dispatch. When explicit dispatch is enabled, jobs will not
     * be dispatched to rooms automatically. Instead, you can either specify the agent(s) to be
     * dispatched in the end-user's token, or use the AgentDispatch.createDispatch API.
     *
     * By default it uses `LIVEKIT_AGENT_NAME` from environment.
     */
    agentName?: string;
    /**
     * Internal flag indicating that `agentName` was resolved from `LIVEKIT_AGENT_NAME`. Forwarded
     * through ServerOptions re-construction (e.g. cli.ts spread) so the env-source signal isn't
     * lost.
     */
    agentNameIsEnv?: boolean;
    serverType?: JobType;
    maxRetry?: number;
    wsURL?: string;
    apiKey?: string;
    apiSecret?: string;
    workerToken?: string;
    host?: string;
    port?: number;
    logLevel?: string;
    production?: boolean;
    simulation?: boolean;
    jobMemoryWarnMB?: number;
    jobMemoryLimitMB?: number;
  }) {
    this.agent = agent;
    if (!this.agent) {
      throw new Error('No Agent file was passed to the worker');
    }
    this.requestFunc = requestFunc;
    this.loadFunc = loadFunc;
    this.loadThreshold = simulation ? Infinity : loadThreshold || Default.loadThreshold(production);
    this.numIdleProcesses = numIdleProcesses || Default.numIdleProcesses(production);
    this.shutdownProcessTimeout = shutdownProcessTimeout;
    this.initializeProcessTimeout = initializeProcessTimeout;
    this.permissions = permissions;
    // agentNameIsEnv may be passed explicitly when ServerOptions is re-constructed (e.g.
    // cli.ts spreads an existing ServerOptions instance), so prefer it when defined.
    if (process.env.LIVEKIT_AGENT_NAME_OVERRIDE) {
      // Highest priority: `lk simulate` sets this to force the worker to register
      // under the agent name it dispatches to, overriding any configured agentName.
      this.agentName = process.env.LIVEKIT_AGENT_NAME_OVERRIDE;
      this.agentNameIsEnv = agentNameIsEnv ?? true;
    } else if (agentName) {
      this.agentName = agentName;
      this.agentNameIsEnv = agentNameIsEnv ?? false;
    } else if (process.env.LIVEKIT_AGENT_NAME) {
      this.agentName = process.env.LIVEKIT_AGENT_NAME;
      this.agentNameIsEnv = agentNameIsEnv ?? true;
    } else {
      this.agentName = '';
      this.agentNameIsEnv = agentNameIsEnv ?? false;
    }
    this.serverType = serverType;
    this.maxRetry = maxRetry;
    this.wsURL = wsURL;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.workerToken = workerToken;
    this.host = host;
    this.port = port || Default.port(production);
    this.logLevel = logLevel;
    this.production = production;
    this.simulation = simulation;
    this.jobMemoryWarnMB = jobMemoryWarnMB;
    this.jobMemoryLimitMB = jobMemoryLimitMB;
  }
}

class PendingAssignment {
  promise = new ThrowsPromise<JobAssignment, never>((resolve) => {
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
export class AgentServer {
  #opts: ServerOptions;
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
  #httpServer?: HTTPServer;
  #logger = log().child({ version });
  #inferenceExecutor?: InferenceProcExecutor;

  /* @throws {@link MissingCredentialsError} if URL, API key or API secret are missing */
  constructor(opts: ServerOptions) {
    opts.wsURL = opts.wsURL || process.env.LIVEKIT_URL || '';
    opts.apiKey = opts.apiKey || process.env.LIVEKIT_API_KEY || '';
    opts.apiSecret = opts.apiSecret || process.env.LIVEKIT_API_SECRET || '';

    if (opts.wsURL === '')
      throw new MissingCredentialsError(
        'URL is required: Set LIVEKIT_URL, run with --url, or pass wsURL in ServerOptions',
      );
    if (opts.apiKey === '')
      throw new MissingCredentialsError(
        'API Key is required: Set LIVEKIT_API_KEY, run with --api-key, or pass apiKey in ServerOptions',
      );
    if (opts.apiSecret === '')
      throw new MissingCredentialsError(
        'API Secret is required: Set LIVEKIT_API_SECRET, run with --api-secret, or pass apiSecret in ServerOptions',
      );

    if (opts.workerToken) {
      // Re-export into the environment so forked subprocesses inherit it (fork()
      // copies process.env by default). The inference-header code in the child reads
      // process.env.LIVEKIT_WORKER_TOKEN — see inference/utils.ts buildMetadataHeaders().
      // Mirrors Python worker.py, which sets os.environ before spawning job procs.
      process.env.LIVEKIT_WORKER_TOKEN = opts.workerToken;

      if (opts.loadFunc !== defaultCpuLoad) {
        this.#logger.warn(
          'custom loadFunc is not supported when deploying to Cloud, using defaults',
        );
        opts.loadFunc = defaultCpuLoad;
      }
      const loadThreshold = Default.loadThreshold(opts.production);
      if (opts.loadThreshold !== loadThreshold) {
        this.#logger.warn(
          'custom loadThreshold is not supported when deploying to Cloud, using defaults',
        );
        opts.loadThreshold = loadThreshold;
      }
    }

    // Register the local audio-EOT runner so it runs in the shared inference
    // process (loaded once per host, ~138 MB) instead of in every job worker.
    // Guarded by binding availability: on a platform where
    // `@livekit/local-inference` can't load, skip registration so the worker
    // still starts (local EOT then degrades to a positive-default prediction).
    maybeRegisterLocalEotRunner();

    this.#inferenceExecutor = InferenceProcExecutor.createIfNeeded();

    this.#procPool = new ProcPool(
      opts.agent,
      opts.numIdleProcesses,
      opts.initializeProcessTimeout,
      opts.shutdownProcessTimeout,
      this.#inferenceExecutor,
      opts.jobMemoryWarnMB,
      opts.jobMemoryLimitMB,
    );

    this.#opts = opts;

    // Simulations run ephemeral workers side by side; a health endpoint on a fixed port would make
    // concurrent runs collide.
    if (!opts.simulation) {
      const healthCheck = () => {
        // Check if inference executor exists and is not alive
        if (this.#inferenceExecutor && !this.#inferenceExecutor.isAlive) {
          return { healthy: false, message: 'inference process not running' };
        }

        // Only healthy when fully connected with an active WebSocket
        if (
          this.#closed ||
          this.#connecting ||
          !this.#session ||
          this.#session.readyState !== WebSocket.OPEN
        ) {
          return { healthy: false, message: 'not connected to livekit' };
        }

        return { healthy: true, message: 'OK' };
      };

      const getWorkerInfo = () => ({
        agent_name: opts.agentName,
        agent_name_is_env: opts.agentNameIsEnv,
        worker_type: JobType[opts.serverType],
        active_jobs: this.activeJobs.length,
        sdk_version: version,
        project_type: PROJECT_TYPE,
      });

      this.#httpServer = new HTTPServer(opts.host, opts.port, healthCheck, getWorkerInfo);
    }
  }

  /** @throws {@link WorkerError} if worker failed to connect or already running */
  async run() {
    if (!this.#closed) {
      throw new WorkerError('worker is already running');
    }

    if (this.#inferenceExecutor) {
      await this.#inferenceExecutor.start();
      await this.#inferenceExecutor.initialize();
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
        const wsUrl = new URL(url + 'agent');
        if (this.#opts.workerToken) {
          wsUrl.searchParams.append('worker_token', this.#opts.workerToken);
        }
        this.#session = new WebSocket(wsUrl, {
          headers: { authorization: 'Bearer ' + jwt },
        });

        try {
          await new ThrowsPromise<unknown, Error>((resolve, reject) => {
            this.#session!.on('open', resolve);
            this.#session!.on('error', (error) => reject(error));
            this.#session!.on('close', (code) => reject(new Error(`WebSocket returned ${code}`)));
          });

          retries = 0;
          this.#logger.debug('connected to LiveKit server');
          await this.#runWS(this.#session);
        } catch (e: unknown) {
          if (this.#closed) return;
          if (retries >= this.#opts.maxRetry) {
            throw new WorkerError(
              `failed to connect to LiveKit server (${this.#opts.wsURL}) after ${retries} attempts: ${e}`,
            );
          }

          retries++;
          const delay = Math.min(retries * 2, 10);

          this.#logger.warn(
            { error: e, retry_count: retries, max_retry: this.#opts.maxRetry },
            `failed to connect to LiveKit server (${this.#opts.wsURL}), retrying in ${delay} seconds: (${retries}/${this.#opts.maxRetry})`,
          );

          await new ThrowsPromise<void, never>((resolve) => setTimeout(resolve, delay * 1000));
        }
      }
    };

    const tasks = [workerWS()];
    if (this.#httpServer) {
      tasks.push(this.#httpServer.run());
    }
    await ThrowsPromise.all(tasks);
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

  /** @throws {@link WorkerError} if worker did not drain in time */
  async drain(timeout?: number): Promise<Throws<void, WorkerError | Error>> {
    if (this.#draining) {
      return;
    }

    this.#logger.debug('draining worker');
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

    const joinJobs = async (): Promise<Throws<void[], Error>> => {
      return ThrowsPromise.all(
        this.#procPool.processes.map((proc): Promise<Throws<void, Error>> => {
          if (!proc.runningJob) {
            proc.close();
          }
          return proc.join();
        }),
      );
    };

    const promises = [joinJobs()];

    if (timeout) {
      promises.push(
        rejectOnAbort(AbortSignal.timeout(timeout)).catch(() => {
          throw new WorkerError('timed out draining');
        }),
      );
    }
    await ThrowsPromise.race(promises);
  }

  async simulateJob(roomName: string, participantIdentity?: string) {
    const client = new RoomServiceClient(this.#opts.wsURL, this.#opts.apiKey, this.#opts.apiSecret);
    const room = await client.createRoom({ name: roomName });
    let participant: ParticipantInfo | undefined = undefined;
    if (participantIdentity) {
      try {
        // TODO(AJS-269): resolve compatibility issue with node-sdk to remove the forced type casting
        participant = (await client.getParticipant(
          roomName,
          participantIdentity,
        )) as unknown as ParticipantInfo;
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

  async #runWS(ws: WebSocket) {
    let closingWS = false;

    const send = (msg: WorkerMessage) => {
      if (closingWS) {
        this.event.off('worker_msg', send);
        return;
      }
      ws.send(msg.toBinary());
    };
    this.event.on('worker_msg', send);

    const close = new ThrowsPromise<void, APIStatusError>((resolve, reject) => {
      ws.addEventListener('close', (event) => {
        closingWS = true;
        if (!this.#closed) {
          reject(
            new APIStatusError({
              message: 'worker connection closed unexpectedly',
              options: {
                statusCode: event.code || -1,
                body: {
                  code: event.code,
                  reason: event.reason,
                  wasClean: event.wasClean,
                },
              },
            }),
          );
          return;
        }
        resolve();
      });
    });

    ws.addEventListener('error', (event) => {
      this.#logger.error('worker error:', event.message);
    });

    ws.addEventListener('message', (event) => {
      let data: Uint8Array;
      if (event.data instanceof Uint8Array) {
        data = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        data = new Uint8Array(event.data);
      } else if (Array.isArray(event.data)) {
        data = Buffer.concat(event.data);
      } else {
        let wsData = String(event.data);
        if (wsData.length > 128) {
          wsData = `${wsData.slice(0, 128)}...(+${wsData.length - 128} more)`;
        }
        const type = typeof event.data;
        this.#logger.warn({ type, ws_data: wsData }, `unexpected message type: ${type}`);
        return;
      }

      const msg = new ServerMessage();
      msg.fromBinary(data);

      // register is the only valid first message, and it is only valid as the
      // first message
      if (this.#connecting && msg.message.case !== 'register') {
        throw new WorkerError('expected register response as first message');
      }

      switch (msg.message.case) {
        case 'register': {
          this.#id = msg.message.value.workerId;
          this.#logger
            .child({
              id: this.id,
              agentName: this.#opts.agentName,
              agentNameIsEnv: this.#opts.agentNameIsEnv,
              server_info: msg.message.value.serverInfo,
            })
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
          task.finally(() => {
            const taskIndex = this.#tasks.indexOf(task);
            if (taskIndex !== -1) {
              this.#tasks.splice(taskIndex, 1);
            } else {
              throw new Error(`task ${task} not found in tasks`);
            }
          });
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
          task.finally(() => {
            const taskIndex = this.#tasks.indexOf(task);
            if (taskIndex !== -1) {
              this.#tasks.splice(taskIndex, 1);
            } else {
              throw new Error(`task ${task} not found in tasks`);
            }
          });
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
            type: this.#opts.serverType,
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

      if (this.#draining) {
        if (currentStatus !== WorkerStatus.WS_FULL) {
          currentStatus = WorkerStatus.WS_FULL;
          this.event.emit(
            'worker_msg',
            new WorkerMessage({
              message: {
                case: 'updateWorker',
                value: {
                  load: 1,
                  status: WorkerStatus.WS_FULL,
                },
              },
            }),
          );
        }
        return;
      }

      const oldStatus = currentStatus;
      this.#opts
        .loadFunc(this)
        .then((currentLoad: number) => {
          const isFull = currentLoad >= this.#opts.loadThreshold;
          const currentlyAvailable = !isFull;
          currentStatus = currentlyAvailable ? WorkerStatus.WS_AVAILABLE : WorkerStatus.WS_FULL;

          if (isFull) {
            this.#procPool.setTargetIdleProcesses(this.#opts.numIdleProcesses);
          } else {
            const activeJobs = this.activeJobs.length;
            if (activeJobs > 0) {
              const jobLoad = currentLoad / activeJobs;
              if (jobLoad > 0) {
                const availableLoad = Math.max(this.#opts.loadThreshold - currentLoad, 0.0);
                const availableJob = Math.min(
                  Math.ceil(availableLoad / jobLoad),
                  this.#opts.numIdleProcesses,
                );
                this.#procPool.setTargetIdleProcesses(availableJob);
              }
            } else {
              this.#procPool.setTargetIdleProcesses(this.#opts.numIdleProcesses);
            }
          }

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
        })
        .catch((e) => {
          this.#logger.warn({ error: e }, 'failed to measure CPU load');
        });
    }, UPDATE_LOAD_INTERVAL);

    try {
      await close;
    } finally {
      ws.removeAllListeners();
    }
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
              // Stamp the agent name on the participant (matches the Python SDK).
              // Consumers like `lk agent simulate` find the agent participant by
              // this attribute; without it they never detect the agent joining.
              participantAttributes: {
                ...args.attributes,
                [ATTRIBUTE_AGENT_NAME]: this.#opts.agentName,
              },
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
        try {
          await this.#procPool.launchJob({
            acceptArguments: args,
            job: msg.job!,
            url: asgn.url || this.#opts.wsURL,
            token: asgn.token,
            workerId: this.id,
            apiKey: this.#opts.apiKey,
            apiSecret: this.#opts.apiSecret,
          });
        } catch (e) {
          this.#logger.child({ requestId: req.id }).error(e, 'error launching job');
        }
      } else {
        this.#logger.child({ requestId: req.id }).warn('pending assignment not found');
      }
    };

    const req = new JobRequest(msg.job!, onReject, onAccept);
    this.#logger
      .child({ jobId: msg.job?.id, resuming: msg.resuming, agentName: this.#opts.agentName })
      .info('received job request');

    if (this.#draining) {
      this.#logger
        .child({ jobId: msg.job?.id, resuming: msg.resuming, agentName: this.#opts.agentName })
        .info('Worker is draining and no longer available, rejecting job');
      await req.reject();
      return;
    }

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
    task.finally(() => {
      const taskIndex = this.#tasks.indexOf(task);
      if (taskIndex !== -1) {
        this.#tasks.splice(taskIndex, 1);
      } else {
        throw new Error(`task ${task} not found in tasks`);
      }
    });
  }

  async #termination(msg: JobTermination) {
    const proc = this.#procPool.getByJobId(msg.jobId);
    if (proc === null) {
      // safe to ignore
      return;
    }
    await proc.close().catch((e) => this.#logger.error(e, 'Error terminating job'));
  }

  async close() {
    if (this.#closed) {
      await this.#close.await;
      return;
    }

    this.#logger.debug('shutting down worker');

    this.#closed = true;

    await this.#inferenceExecutor?.close();
    await this.#procPool.close();
    await this.#httpServer?.close();
    await ThrowsPromise.allSettled(this.#tasks);

    this.#session?.close();
    await this.#close.await;
  }
}

/**
 * @deprecated Use {@link AgentServer} instead. This alias is provided for backward compatibility.
 */
export const Worker = AgentServer;

/**
 * @deprecated Use {@link ServerOptions} instead. This alias is provided for backward compatibility.
 */
export const WorkerOptions = ServerOptions;
