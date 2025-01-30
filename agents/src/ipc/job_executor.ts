// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { RunningJobInfo } from '../job.js';

export interface JobExecutor {
  started: boolean;
  userArguments: any;
  runningJob: RunningJobInfo | undefined;
  status: JobStatus;

  start(): Promise<void>;
  join(): Promise<void>;
  initialize(): Promise<void>;
  close(): Promise<void>;
  launchJob(info: RunningJobInfo): Promise<void>;
}

export enum JobStatus {
  RUNNING,
  FAILED,
  SUCCESS,
}
