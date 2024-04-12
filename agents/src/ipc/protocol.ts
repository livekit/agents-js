// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Job } from '@livekit/protocol';
import { JobContext } from '../job_context';

export type JobMainArgs = {
  jobID: string;
  url: string;
  token: string;
  target: (arg: JobContext) => void;
};

export interface Message {
  MSG_ID: number; // TypeScript is weird with statics; this requires a getter hack
}

export class StartJobRequest implements Message {
  static MSG_ID = 0;
  job: Job;

  get MSG_ID(): number {
    return StartJobRequest.MSG_ID;
  }

  constructor(job = new Job()) {
    this.job = job;
  }
}

export class StartJobResponse implements Message {
  static MSG_ID = 1;
  err?: Error;

  get MSG_ID(): number {
    return StartJobResponse.MSG_ID;
  }

  constructor(err: Error | undefined = undefined) {
    this.err = err;
  }
}

export class Log implements Message {
  static MSG_ID = 2;
  level: number;
  message: string;

  get MSG_ID(): number {
    return Log.MSG_ID;
  }

  constructor(level = 10, message = '') {
    this.level = level;
    this.message = message;
  }
}

export class Ping implements Message {
  static MSG_ID = 3;
  timestamp: number;

  get MSG_ID(): number {
    return Ping.MSG_ID;
  }

  constructor(timestamp = 0) {
    this.timestamp = timestamp;
  }
}

export class Pong implements Message {
  static MSG_ID = 4;
  lastTimestamp: number;
  timestamp: number;

  get MSG_ID(): number {
    return Pong.MSG_ID;
  }

  constructor(lastTimestamp = 0, timestamp = 0) {
    this.lastTimestamp = lastTimestamp;
    this.timestamp = timestamp;
  }
}

export class ShutdownRequest implements Message {
  static MSG_ID = 5;

  get MSG_ID(): number {
    return ShutdownRequest.MSG_ID;
  }
}

export class ShutdownResponse implements Message {
  static MSG_ID = 6;

  get MSG_ID(): number {
    return ShutdownResponse.MSG_ID;
  }
}

export class UserExit implements Message {
  static MSG_ID = 7;

  get MSG_ID(): number {
    return UserExit.MSG_ID;
  }
}

export const IPC_MESSAGES: { [x: number]: Message } = {
  [StartJobRequest.MSG_ID]: new StartJobRequest(),
  [StartJobResponse.MSG_ID]: new StartJobResponse(),
  [Log.MSG_ID]: new Log(),
  [Ping.MSG_ID]: new Ping(),
  [Pong.MSG_ID]: new Pong(),
  [ShutdownRequest.MSG_ID]: new ShutdownRequest(),
  [ShutdownResponse.MSG_ID]: new ShutdownResponse(),
  [UserExit.MSG_ID]: new UserExit(),
};
