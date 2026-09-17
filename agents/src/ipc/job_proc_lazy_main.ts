// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Room, RoomEvent, dispose } from '@livekit/rtc-node';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import { context as otelContext, trace } from '@opentelemetry/api';
import { EventEmitter, once } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { type Agent, isAgent } from '../generator.js';
import {
  JobContext,
  JobProcess,
  type RunningJobInfo,
  runWithJobContext,
  runWithJobContextAsync,
} from '../job.js';
import {
  finalizeSession,
  flushJobLogs,
  flushJobMetrics,
  flushJobTraces,
  runShutdownCallbacks,
  validateSessionEndTimeout,
  waitForEntrypointShutdown,
} from '../job_lifecycle.js';
import { initializeLogger, log } from '../log.js';
import { loggerOptions, setLoggerState } from '../log_core.js';
import type { SimulationContext } from '../simulation.js';
import { recordException, traceTypes, tracer } from '../telemetry/index.js';
import { getMonitor, startMonitoring, stopMonitoring } from '../telemetry/loop_monitor.js';
import { Future, shortuuid } from '../utils.js';
import { defaultInitializeProcessFunc } from '../worker.js';
import { preload } from './_preload.js';
import type { InferenceExecutor } from './inference_executor.js';
import { startJobSpan } from './job_trace.js';
import type { IPCMessage } from './message.js';

const ORPHANED_TIMEOUT = 15 * 1000;
const EXIT_REASON = {
  roomDisconnected: 'room disconnected',
  shutdownRequest: 'shutdown request',
  jobCrashed: 'job crashed',
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
      log().error({ error, msgCase: msg.case }, 'IPC send failed unexpectedly');
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
  // a shutdown the agent asked for (ctx.shutdown()), as opposed to the room dropping or the
  // worker's request
  let userInitiated = false;

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
    userInitiated = true;
    closeEvent.emit('close', reason);
  };

  const ctx = new JobContext(proc, info, room, onConnect, onShutdown, new InfClient());
  ctx._simulationEndFnc = onSimulationEnd;

  const task = (async () => {
    // before the first span: without a provider the job's root would not record
    await ctx._prepareTelemetry();

    // the job's root span, from the availability request to the end of shutdown; the
    // entrypoint returning is an event on it
    const jobSpan = startJobSpan(ctx);
    const jobSpanContext = trace.setSpan(otelContext.active(), jobSpan);
    ctx._jobSpanContext = jobSpanContext;
    let closeReason = '';

    const unconnectedTimeout = setTimeout(() => {
      if (!(connect || shutdown)) {
        logger.warn(
          'room not connect after job_entry was called after 10 seconds, ',
          'did you forget to call ctx.connect()?',
        );
      }
    }, 10000);

    try {
      try {
        const closePromise = once(closeEvent, 'close').then((close) => {
          logger.debug('shutting down');
          shutdown = true;
          closeReason = String(close[0] ?? '');
          safeSend({
            case: 'exiting',
            value: { reason: close[0] },
          });
        });

        // Run the job function within the AsyncLocalStorage context, under the job's span:
        // agent_session and everything else the entrypoint starts nests below it
        const entrypointPromise = runWithJobContextAsync(ctx, () =>
          otelContext.with(jobSpanContext, async () => {
            // the loop monitor's heartbeat predates the job: give its reports this context
            getMonitor()?.setReportContext(otelContext.active(), (fn) =>
              runWithJobContext(ctx, fn),
            );
            try {
              await func(ctx);
            } catch (error) {
              recordException(jobSpan, error instanceof Error ? error : new Error(String(error)));
              throw error;
            }
            jobSpan.addEvent('entrypoint_returned');
          }),
        );

        void entrypointPromise.catch(() => {
          closeEvent.emit('close', EXIT_REASON.jobCrashed);
        });
        await closePromise;
        await waitForEntrypointShutdown(entrypointPromise, logger);
      } finally {
        clearTimeout(unconnectedTimeout);
      }

      // the shutdown sequence as one bar under the job: session close, the user's
      // onSessionEnd, the report upload, the room disconnect, and the shutdown callbacks
      await runWithJobContextAsync(ctx, () =>
        tracer.startActiveSpan(
          async () => {
            try {
              await finalizeSession(ctx, onSessionEnd, sessionEndTimeout, logger);
            } finally {
              safeSend({ case: 'shuttingDown', value: undefined });
            }

            await tracer.startActiveSpan(
              async (span) => {
                try {
                  await room.disconnect();
                  logger.debug('disconnected from room');
                } catch (error) {
                  recordException(span, error instanceof Error ? error : new Error(String(error)));
                  logger.error({ error }, 'error while disconnecting room');
                }
              },
              { name: 'room_disconnect' },
            );

            await runShutdownCallbacks(ctx.shutdownCallbacks, logger);
          },
          {
            name: 'job_shutdown',
            context: jobSpanContext,
            attributes: {
              [traceTypes.ATTR_SHUTDOWN_REASON]: closeReason,
              [traceTypes.ATTR_SHUTDOWN_USER_INITIATED]: userInitiated,
            },
          },
        ),
      );
    } finally {
      // whatever happened above, the job ends: root span, per-job telemetry state, flushes
      jobSpan.end();
      ctx._onCleanup();
      try {
        await flushJobTraces(logger);
        await flushJobLogs(logger);
      } finally {
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

    const moduleFile = process.argv[2];
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

    const sessionEndTimeout = await once(process, 'message').then(([msg]: IPCMessage[]) => {
      msg = msg!;
      if (msg.case !== 'initializeRequest') {
        throw new Error('first message must be InitializeRequest');
      }
      initializeLogger(msg.value.loggerOptions);
      return validateSessionEndTimeout(msg.value.sessionEndTimeout ?? Number.NaN);
    });
    const proc = new JobProcess();
    let logger = log().child({ pid: proc.pid });

    process.on('unhandledRejection', (reason) => {
      logger.debug({ error: reason }, 'Unhandled promise rejection in job process');
    });

    logger.debug('initializing job runner');
    // the framework's warm-up, ahead of the user's: one-time work that would otherwise stall
    // the loop at session start
    preload();
    await agent.prewarm(proc);
    logger.debug('job runner initialized');
    const loopMonitor = startMonitoring({ name: 'job' });
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

          logger = logger.child({
            jobID: msg.value.runningJob.job.id,
            room_id: msg.value.runningJob.job.room?.sid,
          });
          setLoggerState(logger, loggerOptions()!);

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
            safeSend({ case: 'shuttingDown', value: undefined });
            join.resolve();
          }
          closeEvent.emit('close', msg.value?.reason ?? EXIT_REASON.shutdownRequest);
        }
      }
    };

    process.on('message', messageHandler);

    await join.await;
    // stop the monitor first so a stall from the shutdown callbacks is recorded, then export:
    // the periodic reader gets no further turn before process.exit() below
    if (loopMonitor) stopMonitoring(loopMonitor);
    await flushJobMetrics(logger);
    clearTimeout(orphanedTimeout);
    process.off('message', messageHandler);

    // Dispose native FFI resources (Rust FfiServer, tokio runtimes, libwebrtc)
    // before process.exit() to prevent libc++abi mutex crash during teardown.
    // Without this, process.exit() can kill the process while native threads are
    // still running, causing: "mutex lock failed: Invalid argument"
    // See: https://github.com/livekit/node-sdks/issues/564
    try {
      await dispose();
      logger.debug('native resources disposed');
    } catch (error) {
      logger.warn({ error }, 'failed to dispose native resources');
    }

    logger.debug('Job process shutdown');
    process.exit(0);
  }
})();
