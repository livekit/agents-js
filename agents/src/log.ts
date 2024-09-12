// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import { pino } from 'pino';

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
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
            },
          },
        }
      : {},
  );
  if (level) {
    logger.level = level;
  }
};
