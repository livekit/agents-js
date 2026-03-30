// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Throws } from '@livekit/throws-transformer/throws';
import type { RunningJobInfo } from '../job.js';

export interface JobExecutor {
  started: boolean;
  userArguments: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  runningJob: RunningJobInfo | undefined;
  status: JobStatus;

  start(): Promise<Throws<void, Error>>;
  join(): Promise<Throws<void, Error>>;
  initialize(): Promise<Throws<void, Error>>;
  close(): Promise<Throws<void, Error>>;
  launchJob(info: RunningJobInfo): Promise<Throws<void, Error>>;
}

export enum JobStatus {
  RUNNING,
  FAILED,
  SUCCESS,
}
