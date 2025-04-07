// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Room, RoomEvent } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { type Agent, isAgent } from '../generator.js';
import { CurrentJobContext, JobContext, JobProcess, type RunningJobInfo } from '../job.js';
import { initializeLogger, log } from '../log.js';
import { defaultInitializeProcessFunc } from '../worker.js';
import type { InferenceExecutor } from './inference_executor.js';
import type { IPCMessage } from './message.js';

const ORPHANED_TIMEOUT = 15 * 1000;

type JobTask = {
  ctx: JobContext;
  task: Promise<void>;
};

class PendingInference {
  promise = new Promise<{ requestId: string; data: unknown; error?: Error }>((resolve) => {
    this.resolve = resolve; // this is how JavaScript lets you resolve promises externally
  });
  resolve(arg: { requestId: string; data: unknown; error?: Error }) {
    arg; // useless call to counteract TypeScript E6133
  }
}

class InfClient implements InferenceExecutor {
  #requests: { [id: string]: PendingInference } = {};

  constructor() {
    process.on('message', (msg: IPCMessage) => {
      switch (msg.case) {
        case 'inferenceResponse':
          const fut = this.#requests[msg.value.requestId];
          delete this.#requests[msg.value.requestId];
          if (!fut) {
            log().child({ resp: msg.value }).warn('received unexpected inference response');
            return;
          }
          fut.resolve(msg.value);
          break;
      }
    });
  }

  async doInference(method: string, data: unknown): Promise<unknown> {
    const requestId = 'inference_job_' + randomUUID;
    process.send!({ case: 'inferenceRequest', value: { requestId, method, data } });
    this.#requests[requestId] = new PendingInference();
    const resp = await this.#requests[requestId]!.promise;
    if (resp.error) {
      throw new Error(`inference of ${method} failed: ${resp.error.message}`);
    }
    return resp.data;
  }
}

const startJob = (
  proc: JobProcess,
  func: (ctx: JobContext) => Promise<void>,
  info: RunningJobInfo,
  closeEvent: EventEmitter,
  logger: Logger,
): JobTask => {
  let connect = false;
  let shutdown = false;

  const room = new Room();
  room.on(RoomEvent.Disconnected, () => {
    closeEvent.emit('close', false);
  });

  const onConnect = () => {
    connect = true;
  };
  const onShutdown = (reason: string) => {
    shutdown = true;
    closeEvent.emit('close', true, reason);
  };

  const ctx = new JobContext(proc, info, room, onConnect, onShutdown, new InfClient());
  new CurrentJobContext(ctx);

  const task = new Promise<void>(async () => {
    const unconnectedTimeout = setTimeout(() => {
      if (!(connect || shutdown)) {
        logger.warn(
          'room not connect after job_entry was called after 10 seconds, ',
          'did you forget to call ctx.connect()?',
        );
      }
    }, 10000);
    func(ctx).finally(() => clearTimeout(unconnectedTimeout));

    await once(closeEvent, 'close').then((close) => {
      logger.debug('shutting down');
      process.send!({ case: 'exiting', value: { reason: close[1] } });
    });

    await room.disconnect();
    logger.debug('disconnected from room');

    const shutdownTasks = [];
    for (const callback of ctx.shutdownCallbacks) {
      shutdownTasks.push(callback());
    }
    await Promise.all(shutdownTasks).catch(() => logger.error('error while shutting down the job'));

    process.send!({ case: 'done' });
    logger.info('job completed.');
    process.exit();
  });

  return { ctx, task };
};

(async () => {
  if (process.send) {
    // process.argv:
    //   [0] `node'
    //   [1] import.meta.filename
    //   [2] import.meta.filename of function containing entry file
    const moduleFile = process.argv[2];
    const agent: Agent = await import(pathToFileURL(moduleFile!).pathname).then((module) => {
      const agent = module.default;
      if (agent === undefined || !isAgent(agent)) {
        throw new Error(`Unable to load agent: Missing or invalid default export in ${moduleFile}`);
      }
      return agent;
    });
    if (!agent.prewarm) {
      agent.prewarm = defaultInitializeProcessFunc;
    }

    // don't do anything on C-c
    // this is handled in cli, triggering a termination of all child processes at once.
    process.on('SIGINT', () => {
      logger.info('SIGINT received in job proc');
    });

    // don't do anything on SIGTERM
    // Render uses SIGTERM in autoscale, this ensures the processes are properly drained if needed
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received in job proc');
    });

    await once(process, 'message').then(([msg]: IPCMessage[]) => {
      msg = msg!;
      if (msg.case !== 'initializeRequest') {
        throw new Error('first message must be InitializeRequest');
      }
      initializeLogger(msg.value.loggerOptions);
    });
    const proc = new JobProcess();
    let logger = log().child({ pid: proc.pid });

    process.on('unhandledRejection', (reason) => {
      logger.error(reason);
    });

    logger.debug('initializing job runner');
    agent.prewarm(proc);
    logger.debug('job runner initialized');
    process.send({ case: 'initializeResponse' });

    let job: JobTask | undefined = undefined;
    const closeEvent = new EventEmitter();

    const orphanedTimeout = setTimeout(() => {
      logger.warn('job process orphaned, shutting down.');
      process.exit();
    }, ORPHANED_TIMEOUT);

    process.on('message', (msg: IPCMessage) => {
      switch (msg.case) {
        case 'pingRequest': {
          orphanedTimeout.refresh();
          process.send!({
            case: 'pongResponse',
            value: { lastTimestamp: msg.value.timestamp, timestamp: Date.now() },
          });
          break;
        }
        case 'startJobRequest': {
          if (job) {
            throw new Error('job task already running');
          }

          logger = logger.child({ jobID: msg.value.runningJob.job.id });

          job = startJob(proc, agent.entry, msg.value.runningJob, closeEvent, logger);
          logger.debug('job started');
          break;
        }
        case 'shutdownRequest': {
          if (!job) {
            break;
          }
          closeEvent.emit('close', '');
        }
      }
    });
  }
})();
