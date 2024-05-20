// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobAssignment, ServerMessage } from '@livekit/protocol';
import { Room } from '@livekit/rtc-node';
import { type ChildProcess, fork } from 'child_process';
import { EventEmitter, once } from 'events';
import { JobContext } from '../job_context.js';
import { log } from '../log.js';
import { IPC_MESSAGE, type JobMainArgs, type Message, type Ping } from './protocol.js';

export const runJob = (args: JobMainArgs): ChildProcess => {
  return fork(import.meta.filename, [args.raw, args.entry, args.fallbackURL]);
};

if (process.send) {
  // process.argv:
  //   [0] `node'
  //   [1] import.meta.filename
  //   [2] proto.JobAssignment, serialized to JSON string
  //   [3] import.meta.filename of function containing entry file
  //   [4] fallback URL in case JobAssignment.url is empty

  const msg = new ServerMessage();
  msg.fromJsonString(process.argv[2]);
  const args = msg.message.value as JobAssignment;

  const room = new Room();
  const closeEvent = new EventEmitter();
  let shuttingDown = false;
  let closed = false;

  process.on('message', (msg: Message) => {
    if (msg.type === IPC_MESSAGE.ShutdownRequest) {
      shuttingDown = true;
      closed = true;
      closeEvent.emit('close');
    } else if (msg.type === IPC_MESSAGE.Ping) {
      process.send!({
        type: IPC_MESSAGE.Pong,
        lastTimestamp: (msg as Ping).timestamp,
        timestamp: Date.now(),
      });
    }
  });

  // don't do anything on C-c
  process.on('SIGINT', () => {});

  const conn = room.connect(args.url || process.argv[4], args.token);

  const start = () => {
    if (room.isConnected && !closed) {
      process.send!({ type: IPC_MESSAGE.StartJobResponse });

      // here we import the file containing the exported entry function, and call it.
      // the file must export default an Agent, usually using defineAgent().
      import(process.argv[3]).then((agent) => {
        agent.default.entry(new JobContext(closeEvent, args.job!, room));
      });
    }
  };

  new Promise(() => {
    conn
      .then(() => {
        if (!closed) start();
      })
      .catch((err) => {
        if (!closed) process.send!({ type: IPC_MESSAGE.StartJobResponse, err });
      });
  });

  await once(closeEvent, 'close');
  log.debug('disconnecting from room');
  await room.disconnect();
  if (shuttingDown) {
    process.send({ type: IPC_MESSAGE.ShutdownResponse });
  } else {
    process.send({ type: IPC_MESSAGE.UserExit });
  }
  process.exit();
}
