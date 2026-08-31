// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Room, RoomEvent, dispose } from '@livekit/rtc-node';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import { EventEmitter, once } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { safeErrorType } from '../error_utils.js';
import { type Agent, isAgent } from '../generator.js';
import { JobContext, JobProcess, type RunningJobInfo, runWithJobContextAsync } from '../job.js';
import {
  closeAgentSession,
  finalizeSession,
  flushJobLogs,
  runShutdownCallbacks,
} from '../job_lifecycle.js';
import { initializeLogger, log } from '../log.js';
import type { SimulationContext } from '../simulation.js';
import { Future, shortuuid } from '../utils.js';
import { defaultInitializeProcessFunc } from '../worker.js';
import type { InferenceExecutor } from './inference_executor.js';
import type { IPCMessage } from './message.js';

const ORPHANED_TIMEOUT = 15 * 1000;
const EXIT_REASON = {
  roomDisconnected: 'room disconnected',
  userShutdown: 'user shutdown',
  shutdownRequest: 'shutdown request',
  entrypointError: 'entrypoint error',
} as const;

const safeSend = (msg: IPCMessage): boolean => {
  try {
    if (process.connected && process.send) {
      process.send(msg);
      return true;
    }
    return false;
  } catch (error) {
    // Channel closed is expected during graceful shutdown
    // Log at debug level to avoid noise in production logs
    if (error instanceof Error && error.message.includes('Channel closed')) {
      log().debug({ msgCase: msg.case }, 'IPC channel closed, message not sent');
    } else {
      log().error(
        { exceptionType: safeErrorType(error), msgCase: msg.case },
        'IPC send failed unexpectedly',
      );
    }
    return false;
  }
};

type JobTask = {
  ctx: JobContext;
  task: Promise<void>;
};

class PendingInference {
  promise = new ThrowsPromise<{ requestId: string; data: unknown; error?: Error }, never>(
    (resolve) => {
      this.resolve = resolve; // this is how JavaScript lets you resolve promises externally
    },
  );
  resolve(arg: { requestId: string; data: unknown; error?: Error }) {
    arg; // useless call to counteract TypeScript E6133
  }
}

class InfClient implements InferenceExecutor {
  #requests: { [id: string]: PendingInference } = {};
  #logger = log();

  constructor() {
    process.on('message', (msg: IPCMessage) => {
      switch (msg.case) {
        case 'inferenceResponse':
          const fut = this.#requests[msg.value.requestId];
          delete this.#requests[msg.value.requestId];
          if (!fut) {
            this.#logger
              .child({ 'lk.pii.response': msg.value })
              .warn('received unexpected inference response');
            return;
          }
          fut.resolve(msg.value);
          break;
      }
    });
  }

  async doInference(method: string, data: unknown): Promise<unknown> {
    const requestId = shortuuid('inference_job_');
    if (!safeSend({ case: 'inferenceRequest', value: { requestId, method, data } })) {
      this.#logger.debug(
        { method, requestId },
        'IPC channel closed during inference, aborting gracefully',
      );
      throw new Error(`Inference ${method} aborted: IPC channel closed (expected during shutdown)`);
    }

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
  joinFuture: Future,
  sessionEndTimeout: number,
  onSessionEnd?: (ctx: JobContext) => unknown,
  onSimulationEnd?: (ctx: SimulationContext) => unknown,
): JobTask => {
  let connect = false;
  let shutdown = false;

  const room = new Room();
  room.on(RoomEvent.Disconnected, () => {
    if (!shutdown) {
      closeEvent.emit('close', EXIT_REASON.roomDisconnected);
    }
  });

  const onConnect = () => {
    connect = true;
  };
  const onShutdown = (reason: string) => {
    shutdown = true;
    logger.debug({ 'lk.pii.shutdownReason': reason }, 'user requested job shutdown');
    closeEvent.emit('close', EXIT_REASON.userShutdown);
  };

  const ctx = new JobContext(proc, info, room, onConnect, onShutdown, new InfClient());
  ctx._simulationEndFnc = onSimulationEnd;

  const task = (async () => {
    const unconnectedTimeout = setTimeout(() => {
      if (!(connect || shutdown)) {
        logger.warn(
          'room not connect after job_entry was called after 10 seconds, ',
          'did you forget to call ctx.connect()?',
        );
      }
    }, 10000);

    try {
      const closePromise = once(closeEvent, 'close').then((close) => {
        logger.debug('shutting down');
        shutdown = true;
        safeSend({ case: 'exiting', value: { reason: close[0] } });
      });

      // Run the job function within the AsyncLocalStorage context
      await runWithJobContextAsync(ctx, async () => {
        const { tracer, traceTypes } = await import('../telemetry/index.js');
        return tracer.startActiveSpan(
          async (span) => {
            span.setAttribute(traceTypes.ATTR_JOB_ID, info.job.id);
            span.setAttribute(traceTypes.ATTR_AGENT_NAME, info.job.agentName);
            span.setAttribute(traceTypes.ATTR_ROOM_NAME, info.job.room?.name ?? '');
            return func(ctx);
          },
          { name: 'job_entrypoint' },
        );
      })
        .then(async () => {
          if (!shutdown) {
            await closePromise;
          }
        })
        .finally(async () => {
          clearTimeout(unconnectedTimeout);
        });
    } catch (error) {
      logger.error({ exceptionType: safeErrorType(error) }, 'error in entry function');
      shutdown = true;
      safeSend({
        case: 'exiting',
        value: { reason: EXIT_REASON.entrypointError },
      });
    }

    safeSend({ case: 'sessionEndStarted', value: undefined });

    try {
      // Close the primary agent session if it exists
      if (ctx._primaryAgentSession) {
        await closeAgentSession(ctx._primaryAgentSession, logger);
      }

      await finalizeSession(ctx, onSessionEnd, sessionEndTimeout, logger);

      try {
        await room.disconnect();
        logger.debug('disconnected from room');
      } catch (error) {
        logger.error({ exceptionType: safeErrorType(error) }, 'error while disconnecting room');
      }

      await runShutdownCallbacks(ctx.shutdownCallbacks, sessionEndTimeout, logger);
    } finally {
      try {
        await flushJobLogs(logger);
      } finally {
        safeSend({ case: 'shuttingDown', value: undefined });
        safeSend({ case: 'done', value: undefined });
        joinFuture.resolve();
      }
    }
  })();

  return { ctx, task };
};

(async () => {
  if (process.send) {
    const join = new Future();

    // process.argv:
    //   [0] `node'
    //   [1] import.meta.filename
    //   [2] import.meta.filename of function containing entry file
    //   [3] sessionEndTimeout
    const moduleFile = process.argv[2];
    const sessionEndTimeout = Number(process.argv[3]);
    if (!Number.isFinite(sessionEndTimeout) || sessionEndTimeout < 0) {
      throw new Error(`Invalid sessionEndTimeout: ${process.argv[3]}`);
    }
    const agent: Agent = await import(pathToFileURL(moduleFile!).pathname).then((module) => {
      // Handle both ESM (module.default is the agent) and CJS (module.default.default is the agent)
      const agent =
        typeof module.default === 'function' || isAgent(module.default)
          ? module.default
          : module.default?.default;
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
      logger.debug('SIGINT received in job proc');
    });

    // don't do anything on SIGTERM
    // Render uses SIGTERM in autoscale, this ensures the processes are properly drained if needed
    process.on('SIGTERM', () => {
      logger.debug('SIGTERM received in job proc');
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
      logger.debug(
        { exceptionType: safeErrorType(reason) },
        'Unhandled promise rejection in job process',
      );
    });

    logger.debug('initializing job runner');
    await agent.prewarm(proc);
    logger.debug('job runner initialized');
    safeSend({ case: 'initializeResponse', value: undefined });

    let job: JobTask | undefined = undefined;
    const closeEvent = new EventEmitter();

    const orphanedTimeout = setTimeout(() => {
      logger.warn('job process orphaned, shutting down.');
      join.resolve();
    }, ORPHANED_TIMEOUT);

    const messageHandler = (msg: IPCMessage) => {
      switch (msg.case) {
        case 'pingRequest': {
          orphanedTimeout.refresh();
          safeSend({
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

          job = startJob(
            proc,
            agent.entry,
            msg.value.runningJob,
            closeEvent,
            logger,
            join,
            sessionEndTimeout,
            agent.onSessionEnd,
            agent.onSimulationEnd,
          );
          logger.debug('job started');
          break;
        }
        case 'shutdownRequest': {
          safeSend({ case: 'shutdownRequestAck', value: undefined });
          if (!job) {
            safeSend({ case: 'sessionEndStarted', value: undefined });
            safeSend({ case: 'shuttingDown', value: undefined });
            join.resolve();
          }
          closeEvent.emit('close', EXIT_REASON.shutdownRequest);
          clearTimeout(orphanedTimeout);
          process.off('message', messageHandler);
        }
      }
    };

    process.on('message', messageHandler);

    await join.await;

    // Dispose native FFI resources (Rust FfiServer, tokio runtimes, libwebrtc)
    // before process.exit() to prevent libc++abi mutex crash during teardown.
    // Without this, process.exit() can kill the process while native threads are
    // still running, causing: "mutex lock failed: Invalid argument"
    // See: https://github.com/livekit/node-sdks/issues/564
    try {
      await dispose();
      logger.debug('native resources disposed');
    } catch (error) {
      logger.warn({ exceptionType: safeErrorType(error) }, 'failed to dispose native resources');
    }

    logger.debug('Job process shutdown');
    process.exit(0);
  }
})();
