// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { RunningJobInfo } from '../job.js';

export interface ProcOpts {
  agent: string;
  initializeTimeout: number;
  closeTimeout: number;
  memoryWarnMB: number;
  memoryLimitMB: number;
  pingInterval: number;
  pingTimeout: number;
  highPingThreshold: number;
}

export abstract class JobExecutor {
  abstract get started(): boolean;
  abstract get runningJob(): RunningJobInfo | undefined;
  abstract get status(): JobStatus;

  abstract start(): Promise<void>;
  abstract join(): Promise<void>;
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;
  abstract launchJob(info: RunningJobInfo): Promise<void>;
}

export enum JobStatus {
  RUNNING,
  FAILED,
  SUCCESS,
}
