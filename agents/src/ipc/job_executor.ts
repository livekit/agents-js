// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { RunningJobInfo } from '../job.js';

export abstract class JobExecutor {
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
