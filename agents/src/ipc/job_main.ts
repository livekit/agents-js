// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Room, RoomEvent } from '@livekit/rtc-node';
import type { ChildProcess } from 'child_process';
import { fork } from 'child_process';
import { EventEmitter, once } from 'events';
import { fileURLToPath } from 'url';
import type { Agent } from '../generator.js';
import type { RunningJobInfo } from '../job.js';
import { JobContext } from '../job.js';
import { JobProcess } from '../job.js';
import { log, initializeLogger } from '../log.js';
import { defaultInitializeProcessFunc } from '../worker.js';
import type { IPCMessage } from './message.js';

type StartArgs = {
  agentFile: string;
  // userArguments: unknown;
};

type JobTask = {
  ctx: JobContext;
  task: Promise<void>;
};

export const runProcess = (args: StartArgs): ChildProcess => {
  return fork(fileURLToPath(import.meta.url), [args.agentFile]);
};

const startJob = (
  proc: JobProcess,
  func: (ctx: JobContext) => Promise<void>,
  info: RunningJobInfo,
  closeEvent: EventEmitter,
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
        log().warn(
          'room not connect after job_entry was called after 10 seconds, ',
          'did you forget to call ctx.connect()?',
        );
      }
    }, 10000);
    func(ctx).finally(() => clearTimeout(unconnectedTimeout));

    await once(closeEvent, 'close').then((close) => {
      process.send!({ case: 'exiting', reason: close[1] });
    });

    await room.disconnect();

    const shutdownTasks = [];
    for (const callback of ctx.shutdownCallbacks) {
      shutdownTasks.push(callback());
    }
    await Promise.all(shutdownTasks).catch(() => log().error('error while shutting down the job'));

    process.send!({ case: 'done' });
    process.exit();
  });

  return { ctx, task };
};

if (process.send) {
  // process.argv:
  //   [0] `node'
  //   [1] import.meta.filename
  //   [2] import.meta.filename of function containing entry file
  const agent: Agent = await import(process.argv[2]).then((agent) => agent.default);
  if (!agent.prewarm) {
    agent.prewarm = defaultInitializeProcessFunc;
  }

  // don't do anything on C-c
  // this is handled in cli, triggering a termination of all child processes at once.
  process.on('SIGINT', () => {});

  await once(process, 'message').then(([msg]: IPCMessage[]) => {
    if (msg.case !== 'initializeRequest') {
      throw new Error('first message must be InitializeRequest');
    }
    initializeLogger(msg.value.loggerOptions);
  });
  const proc = new JobProcess();

  log().child({ pid: proc.pid }).debug('initializing job runner');
  agent.prewarm(proc);
  log().child({ pid: proc.pid }).debug('job runner initialized');
  process.send({ case: 'initializeResponse' });

  let job: JobTask | undefined = undefined;
  const closeEvent = new EventEmitter();
  process.on('message', (msg: IPCMessage) => {
    switch (msg.case) {
      case 'pingRequest': {
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

        job = startJob(proc, agent.entry, msg.value.runningJob, closeEvent);
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
