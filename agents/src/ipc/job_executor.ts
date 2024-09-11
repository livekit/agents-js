// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { RunningJobInfo } from '../job.js';

export interface ProcOpts {
  agent: string;
  initializeTimeout: number;
  closeTimeout: number;
}

export enum JobExecutorType {
  PROCESS,
  // THREAD, // not yet implemented
}

export abstract class JobExecutor {
  PING_INTERVAL = 2.5 * 1000;
  PING_TIMEOUT = 90 * 1000;
  HIGH_PING_THRESHOLD = 0.5 * 1000;
  NO_MESSAGE_TIMEOUT = 15 * 1000;

  abstract get started(): boolean;
  abstract get startArguments(): unknown;
  abstract set startArguments(value: unknown);
  abstract get runningJob(): RunningJobInfo | undefined;

  abstract start(): Promise<void>;
  abstract join(): Promise<void>;
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;
  abstract launchJob(info: RunningJobInfo): Promise<void>;
}
