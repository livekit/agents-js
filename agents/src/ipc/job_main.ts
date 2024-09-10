// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import type { Agent } from '../generator.js';
import type { JobContext } from '../job.js';
import { JobProcess } from '../job.js';
import { log } from '../log.js';
import { defaultInitializeProcessFunc } from '../worker.js';
import type { IPCMessage } from './message.js';

type StartArgs = {
  agentFile: string;
  userArguments: unknown;
};

type JobTask = {
  ctx: JobContext;
  task: Promise<void>;
};

export const runThreaded = (args: StartArgs): Worker => {
  return new Worker(fileURLToPath(import.meta.url), { workerData: args });
};

const asyncMain = async (
  proc: JobProcess,
  jobEntrypointFunc: (ctx: JobContext) => Promise<void>,
) => {
  const task: JobTask | undefined = undefined;
};

if (!isMainThread) {
  const agent: Agent = await import(workerData.agentFile).then((agent) => agent.default);
  if (!agent.prewarm) {
    agent.prewarm = defaultInitializeProcessFunc;
  }

  let gotRequest = () => {};
  parentPort!.once('message', (msg: IPCMessage) => {
    if (msg.case !== 'initializeRequest') {
      throw new Error('first message must be InitializeRequest');
    }
    gotRequest();
  });
  await new Promise<void>((resolve) => {
    gotRequest = resolve;
  });
  const proc = new JobProcess(workerData.userArguments);

  log().child({ pid: proc.pid }).debug('initializing job runner');
  agent.prewarm(proc);
  log().child({ pid: proc.pid }).debug('job runner initialized');
  parentPort!.emit('message', { case: 'initializeResponse' });

  await asyncMain(proc, agent.entry);
  parentPort!.emit('message', { case: 'done' });
}

//   const msg = new ServerMessage();
//   msg.fromJsonString(process.argv[2]);
//   const args = msg.message.value as JobAssignment;

//   const room = new Room();
//   const closeEvent = new EventEmitter();
//   let shuttingDown = false;
//   let closed = false;

//   process.on('message', (msg: Message) => {
//     if (msg.type === IPC_MESSAGE.ShutdownRequest) {
//       shuttingDown = true;
//       closed = true;
//       closeEvent.emit('close');
//     } else if (msg.type === IPC_MESSAGE.Ping) {
//       process.send!({
//         type: IPC_MESSAGE.Pong,
//         lastTimestamp: (msg as Ping).timestamp,
//         timestamp: Date.now(),
//       });
//     }
//   });

//   const conn = room.connect(args.url || process.argv[4], args.token);

//   const start = () => {
//     if (room.isConnected && !closed) {
//       process.send!({ type: IPC_MESSAGE.StartJobResponse });

//       // here we import the file containing the exported entry function, and call it.
//       // the file must export default an Agent, usually using defineAgent().
//       import(process.argv[3]).then((agent) => {
//         agent.default.entry(new JobContext(closeEvent, args.job!, room));
//       });
//     }
//   };

//   new Promise(() => {
//     conn
//       .then(() => {
//         if (!closed) start();
//       })
//       .catch((err) => {
//         if (!closed) process.send!({ type: IPC_MESSAGE.StartJobResponse, err });
//       });
//   });

//   await once(closeEvent, 'close');
//   log.debug('disconnecting from room');
//   await room.disconnect();
//   if (shuttingDown) {
//     process.send({ type: IPC_MESSAGE.ShutdownResponse });
//   } else {
//     process.send({ type: IPC_MESSAGE.UserExit });
//   }
//   process.exit();
// }

// // child_process implementation
//
// export const runProcess = (args: StartArgs): ChildProcess => {
//   return fork(fileURLToPath(import.meta.url), [args.agentFile, JSON.stringify(args.userArguments)]);
// };
//
// if (process.send) {
//   // process.argv:
//   //   [0] `node'
//   //   [1] import.meta.filename
//   //   [2] import.meta.filename of function containing entry file
//   //   [3] userArguments, as a JSON string
//   const agent: Agent = await import(process.argv[2]).then((agent) => agent.default);
//   if (!agent.prewarm) {
//     agent.prewarm = defaultInitializeProcessFunc;
//   }
//
//   let gotRequest = () => {};
//   process.once('message', (msg: IPCMessage) => {
//     if (msg.case !== 'initializeRequest') {
//       throw new Error('first message must be InitializeRequest');
//     }
//     gotRequest();
//   });
//   await new Promise<void>((resolve) => {
//     gotRequest = resolve;
//   });
//   const proc = new JobProcess(workerData.userArguments);
//
//   log.child({ pid: proc.pid }).debug('initializing process');
//   agent.prewarm(proc);
//   log.child({ pid: proc.pid }).debug('process initialized');
//   process.send({ case: 'initializeResponse' });
//
//   // don't do anything on C-c
//   // this is handled in cli, triggering a termination of all child processes at once.
//   process.on('SIGINT', () => {});
//
//   await asyncMain(proc, agent.entry);
//   process.send({ case: 'done' });
// } else if (!isMainThread) {
