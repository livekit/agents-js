// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { IPC_MESSAGE, JobMainArgs, Message, Ping, StartJobRequest } from './protocol';
import { Room } from '@livekit/rtc-node';
import { EventEmitter, once } from 'events';
import { JobContext } from '../job_context';
import { log } from '../log';
import { AgentEntry } from '../job_request';

export const runJob = async (event: EventEmitter, args: JobMainArgs) => {
  const room = new Room();
  const conn = room.connect(args.url, args.token);
  let request: StartJobRequest | undefined = undefined;
  let shuttingDown = false;
  let closed = false;
  let task: AgentEntry | undefined = undefined;
  let context: JobContext | undefined = undefined;

  const start = () => {
    if (request && room.isConnected && !closed) {
      event.emit('msg', { type: IPC_MESSAGE.StartJobResponse });

      task = args.acceptData.entry;
      context = new JobContext(event, request.job, room);

      task(context);
    }
  };

  new Promise(() => {
    conn
      .then(() => {
        if (!closed) start();
      })
      .catch((err) => {
        if (!closed) event.emit('msg', { type: IPC_MESSAGE.StartJobResponse, err });
      });
  });

  event.on('msg', (msg: Message) => {
    if (msg.type === IPC_MESSAGE.ShutdownRequest) {
      shuttingDown = true;
      closed = true;
      event.emit('close')
    } else if (msg.type === IPC_MESSAGE.StartJobRequest) {
      request = msg as StartJobRequest;
      start();
    } else if (msg.type === IPC_MESSAGE.Ping) {
      event.emit('msg', {
        type: IPC_MESSAGE.Pong,
        lastTimestamp: (msg as Ping).timestamp,
        timestamp: Date.now(),
      });
    }
  });

  await once(event, 'close');
  log.debug('disconnecting from room');
  await room.disconnect();
  if (shuttingDown) {
    event.emit('msg', { type: IPC_MESSAGE.ShutdownResponse });
  } else {
    event.emit('msg', { type: IPC_MESSAGE.UserExit });
    closed = true;
  }
  event.emit('exit');
};
