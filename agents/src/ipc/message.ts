// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JsonValue } from '@bufbuild/protobuf';
import type { RunningJobInfo } from '../job.js';
import type { LoggerOptions } from '../log.js';

export type IPCMessage =
  | {
      case: 'initializeRequest';
      value: {
        loggerOptions: LoggerOptions;
        pingInterval?: number;
        pingTimeout?: number;
        highPingThreshold?: number;
        sessionEndTimeout?: number;
      };
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
      case: 'shutdownRequestAck';
      value: undefined;
    }
  | {
      case: 'shuttingDown';
      value: undefined;
    }
  | {
      case: 'inferenceRequest';
      value: { method: string; requestId: string; data: unknown };
    }
  | {
      case: 'inferenceResponse';
      value: { requestId: string; data: unknown; error?: Error };
    }
  | {
      case: 'exiting';
      value: { reason: string };
    }
  | {
      case: 'done';
      value: undefined;
    }
  | {
      // the job connected: its join instants, a JobJoinTiming as JSON, for the worker to report
      case: 'joinTiming';
      value: JsonValue;
    };
