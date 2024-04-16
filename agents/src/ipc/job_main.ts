// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  JobMainArgs,
  Message,
  Ping,
  Pong,
  ShutdownRequest,
  ShutdownResponse,
  StartJobRequest,
  StartJobResponse,
  UserExit,
} from './protocol';
import { Room } from '@livekit/rtc-node';
import { EventEmitter, once } from 'events';
import { JobContext } from '../job_context';
import { log } from '../log';
import { AgentEntry } from '../job_request';

export const runJob = (event: EventEmitter, args: JobMainArgs) => {
  const room = new Room();
  const conn = room.connect(args.url, args.token);
  let request: StartJobRequest | undefined = undefined;
  let shuttingDown = false;
  let closed = false;
  let task: AgentEntry | undefined = undefined;
  let context: JobContext | undefined = undefined;

  const start = () => {
    if (request && room.isConnected && !closed) {
      event.emit('msg', new StartJobResponse());

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
      .catch(() => {
        if (!closed) event.emit('msg', new StartJobResponse());
      });
  });

  event.once('close', () => {
    event.emit('msg', new UserExit());
    closed = true;
  });

  event.on('msg', (msg: Message) => {
    if (msg instanceof ShutdownRequest) {
      shuttingDown = true;
      closed = true;
    } else if (msg instanceof StartJobRequest) {
      request = msg;
      start();
    } else if (msg instanceof Ping) {
      event.emit('msg', new Pong(msg.timestamp, Date.now()));
    }
  });

  once(event, 'close').then(() => {
    log.debug('disconnecting from room');
    room.disconnect().then(() => {
      if (shuttingDown) {
        event.emit('msg', new ShutdownResponse());
      }

      event.removeAllListeners();
    });
  });
};
