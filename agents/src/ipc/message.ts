// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { RunningJobInfo } from '../job.js';

export type IPCMessage =
  | {
      case: 'initializeRequest';
      value: undefined;
    }
  | {
      case: 'initializeResponse';
      value: undefined;
    }
  | {
      case: 'pingRequest';
      value: { timestamp: number };
    }
  | {
      case: 'pongResponse';
      value: { lastTimestamp: number; timestamp: number };
    }
  | {
      case: 'startJobRequest';
      value: { runningJob: RunningJobInfo };
    }
  | {
      case: 'shutdownRequest';
      value: { reason?: string };
    }
  | {
      case: 'exiting';
      value: { reason?: string };
    }
  | {
      case: 'done';
      value: undefined;
    };
