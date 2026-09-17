// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';

/** @internal */
export type LoggerOptions = {
  pretty: boolean;
  level?: string;
};

// Use Symbol.for() + globalThis to create process-wide singletons.
// This avoids the "dual package hazard". Symbol.for() returns the same Symbol
// across all module instances, and globalThis is shared process-wide.
const LOGGER_KEY = Symbol.for('@livekit/agents:logger');
const LOGGER_OPTIONS_KEY = Symbol.for('@livekit/agents:loggerOptions');
const LOG_CONTEXT_STORAGE_KEY = Symbol.for('@livekit/agents:logContextStorage');

type GlobalState = {
  [LOGGER_KEY]?: Logger;
  [LOGGER_OPTIONS_KEY]?: LoggerOptions;
  [LOG_CONTEXT_STORAGE_KEY]?: AsyncLocalStorage<() => Record<string, unknown>>;
};

const globals = globalThis as typeof globalThis & GlobalState;
const logContextStorage = (globals[LOG_CONTEXT_STORAGE_KEY] ??= new AsyncLocalStorage());

/** @internal */
export const logContextFields = (): Record<string, unknown> =>
  logContextStorage.getStore()?.() ?? {};

/** @internal */
export const runWithLogContext = <T>(fields: () => Record<string, unknown>, fn: () => T): T =>
  logContextStorage.run(fields, fn);

/** @internal */
export const loggerOptions = (): LoggerOptions | undefined => globals[LOGGER_OPTIONS_KEY];

/** @internal */
export const log = (): Logger => {
  const logger = globals[LOGGER_KEY];
  if (!logger) {
    throw new TypeError('logger not initialized. did you forget to run initializeLogger()?');
  }
  return logger;
};

/** @internal */
export const setLoggerState = (logger: Logger, options: LoggerOptions): void => {
  globals[LOGGER_OPTIONS_KEY] = options;
  globals[LOGGER_KEY] = logger;
};
