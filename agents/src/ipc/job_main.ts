// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Room, RoomEvent } from '@livekit/rtc-node';
import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { type Agent, isAgent } from '../generator.js';
import type { RunningJobInfo } from '../job.js';
import { JobContext } from '../job.js';
import { JobProcess } from '../job.js';
import { initializeLogger, log } from '../log.js';
import { defaultInitializeProcessFunc } from '../worker.js';
import type { IPCMessage } from './message.js';

const ORPHANED_TIMEOUT = 15 * 1000;

type StartArgs = {
  agentFile: string;
  // userArguments: unknown;
};

type JobTask = {
  ctx: JobContext;
  task: Promise<void>;
};

export const runProcess = (args: StartArgs): ChildProcess => {
  return fork(new URL(import.meta.url), [args.agentFile]);
};

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

  const ctx = new JobContext(proc, info, room, onConnect, onShutdown);

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
    process.on('SIGINT', () => {});

    await once(process, 'message').then(([msg]: IPCMessage[]) => {
      msg = msg!;
      if (msg.case !== 'initializeRequest') {
        throw new Error('first message must be InitializeRequest');
      }
      initializeLogger(msg.value.loggerOptions);
    });
    const proc = new JobProcess();
    let logger = log().child({ pid: proc.pid });

    logger.debug('initializing job runner');
    agent.prewarm(proc);
    logger.debug('job runner initialized');
    process.send({ case: 'initializeResponse' });

    let job: JobTask | undefined = undefined;
    const closeEvent = new EventEmitter();

    const orphanedTimeout = setTimeout(() => {
      logger.warn('process orphaned, shutting down');
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
