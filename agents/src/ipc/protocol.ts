// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Job } from '@livekit/protocol';
import { AcceptData } from '../job_request';

export type JobMainArgs = {
  jobID: string;
  url: string;
  token: string;
  acceptData: AcceptData;
};

export interface Message {
  type: IPC_MESSAGE;
}

export interface StartJobRequest extends Message {
  type: IPC_MESSAGE.StartJobRequest;
  job: Job;
}

export interface StartJobResponse extends Message {
  type: IPC_MESSAGE.StartJobResponse;
  err?: Error;
}

export interface Ping extends Message {
  type: IPC_MESSAGE.Ping;
  timestamp: number;
}

export interface Pong extends Message {
  type: IPC_MESSAGE.Pong;
  lastTimestamp: number;
  timestamp: number;
}

export interface ShutdownRequest extends Message {
  type: IPC_MESSAGE.ShutdownRequest;
}

export interface ShutdownResponse extends Message {
  type: IPC_MESSAGE.ShutdownResponse;
}

export interface UserExit extends Message {
  type: IPC_MESSAGE.UserExit;
}

export enum IPC_MESSAGE {
  StartJobRequest,
  StartJobResponse,
  Ping,
  Pong,
  ShutdownRequest,
  ShutdownResponse,
  UserExit,
}
