// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Logger, pino } from 'pino';

export type LoggerOptions = {
  pretty: boolean;
  level?: string;
};
export let loggerOptions: LoggerOptions;

let logger: Logger | undefined = undefined;
export const log = () => {
  if (!logger) {
    throw new Error('logger not initialized. did you forget to run initializeLogger()?');
  }
  return logger;
};
export default log;

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
