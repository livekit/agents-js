// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import { pino } from 'pino';
import { type PinoLogObject, emitToOtel } from './telemetry/pino_otel_transport.js';

/** @internal */
export type LoggerOptions = {
  pretty: boolean;
  level?: string;
};

/** @internal */
export let loggerOptions: LoggerOptions;

/** @internal */
let logger: Logger | undefined = undefined;

/** @internal */
let otelEnabled = false;

/** @internal */
export const log = () => {
  if (!logger) {
    throw new TypeError('logger not initialized. did you forget to run initializeLogger()?');
  }
  return logger;
};

/** @internal */
export const initializeLogger = ({ pretty, level }: LoggerOptions) => {
  loggerOptions = { pretty, level };
  logger = pino(
    pretty
      ? {
          level: level || 'info',
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
            },
          },
        }
      : { level: level || 'info' },
  );
};

/**
 * Enable OTEL logging by reconfiguring the logger with a formatter hook.
 * Uses Pino's formatters.log to intercept structured log objects and emit to OTEL.
 *
 * @internal
 */
export const enableOtelLogging = () => {
  if (otelEnabled || !logger) {
    console.warn('OTEL logging already enabled or logger not initialized');
    return;
  }
  otelEnabled = true;

  const { pretty, level } = loggerOptions;

  // Recreate logger with OTEL formatter hook
  logger = pino(
    pretty
      ? {
          level: level || 'info',
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
            },
          },
          formatters: {
            log(obj: Record<string, unknown>) {
              emitToOtel(obj as PinoLogObject);
              return obj;
            },
          },
        }
      : {
          level: level || 'info',
          formatters: {
            log(obj: Record<string, unknown>) {
              emitToOtel(obj as PinoLogObject);
              return obj;
            },
          },
        },
  );
};
