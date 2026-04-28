// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Writable } from 'node:stream';
import type { DestinationStream, Logger } from 'pino';
import { multistream, pino } from 'pino';
import { build as pinoPretty } from 'pino-pretty';
import { type PinoLogObject, emitToOtel } from './telemetry/pino_otel_transport.js';

/** @internal */
export type LoggerOptions = {
  pretty: boolean;
  level?: string;
};

// Use Symbol.for() + globalThis to create process-wide singletons.
// This avoids the "dual package hazard". Symbol.for() returns the same Symbol
// across all module instances, and globalThis is shared process-wide.
const LOGGER_KEY = Symbol.for('@livekit/agents:logger');
const BASE_LOGGER_KEY = Symbol.for('@livekit/agents:baseLogger');
const JOB_CONTEXT_KEY = Symbol.for('@livekit/agents:jobContext');
const LOGGER_OPTIONS_KEY = Symbol.for('@livekit/agents:loggerOptions');
const OTEL_ENABLED_KEY = Symbol.for('@livekit/agents:otelEnabled');

type GlobalState = {
  [LOGGER_KEY]?: Logger;
  [BASE_LOGGER_KEY]?: Logger;
  [JOB_CONTEXT_KEY]?: Record<string, unknown>;
  [LOGGER_OPTIONS_KEY]?: LoggerOptions;
  [OTEL_ENABLED_KEY]?: boolean;
};

const globals = globalThis as typeof globalThis & GlobalState;

/** @internal */
export const loggerOptions = (): LoggerOptions | undefined => globals[LOGGER_OPTIONS_KEY];

/** @internal */
export const log = () => {
  const logger = globals[LOGGER_KEY];
  if (!logger) {
    throw new TypeError('logger not initialized. did you forget to run initializeLogger()?');
  }
  return logger;
};

/**
 * Sets per-job context fields on the global logger. All subsequent calls to
 * {@link log} will return a child logger that includes these fields on every
 * log line (e.g. `jobId`, `roomName`).
 *
 * Call with an empty object to clear the context (e.g. after a job ends).
 *
 * @remarks
 * LiveKit workers process one job at a time, so mutating the global logger
 * is safe — there is no risk of concurrent jobs interleaving context.
 *
 * @internal
 */
export const setJobContext = (ctx: Record<string, unknown>) => {
  if (!globals[BASE_LOGGER_KEY]) {
    globals[BASE_LOGGER_KEY] = globals[LOGGER_KEY];
  }
  const hasFields = Object.keys(ctx).length > 0;
  globals[JOB_CONTEXT_KEY] = hasFields ? ctx : undefined;
  const base = globals[BASE_LOGGER_KEY]!;
  globals[LOGGER_KEY] = hasFields ? base.child(ctx) : base;
};

/** @internal */
export const initializeLogger = ({ pretty, level }: LoggerOptions) => {
  globals[LOGGER_OPTIONS_KEY] = { pretty, level };
  globals[LOGGER_KEY] = pino(
    { level: level || 'info', serializers: { error: pino.stdSerializers.err } },
    pretty ? pinoPretty({ colorize: true }) : process.stdout,
  );
};

/**
 * Custom Pino destination that parses JSON logs and emits to OTEL.
 * This receives the FULL serialized log including msg, level, time, etc.
 */
class OtelDestination extends Writable {
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    try {
      const line = chunk.toString().trim();
      if (line) {
        const logObj = JSON.parse(line) as PinoLogObject;
        emitToOtel(logObj);
      }
    } catch {
      // Ignore parse errors (e.g., non-JSON lines)
    }
    callback();
  }
}

/**
 * Enable OTEL logging by reconfiguring the logger with multistream.
 * Uses a custom destination that receives full JSON logs (with msg, level, time).
 *
 * @internal
 */
export const enableOtelLogging = () => {
  if (globals[OTEL_ENABLED_KEY] || !globals[LOGGER_KEY]) {
    console.warn('OTEL logging already enabled or logger not initialized');
    return;
  }
  globals[OTEL_ENABLED_KEY] = true;

  const opts = globals[LOGGER_OPTIONS_KEY]!;
  const { pretty, level } = opts;

  const logLevel = level || 'info';
  const streams: { stream: DestinationStream; level: string }[] = [
    { stream: pretty ? pinoPretty({ colorize: true }) : process.stdout, level: logLevel },
    { stream: new OtelDestination(), level: 'debug' },
  ];

  const newBase = pino(
    { level: logLevel, serializers: { error: pino.stdSerializers.err } },
    multistream(streams),
  );
  globals[BASE_LOGGER_KEY] = newBase;
  const activeJobCtx = globals[JOB_CONTEXT_KEY];
  globals[LOGGER_KEY] = activeJobCtx ? newBase.child(activeJobCtx) : newBase;
};
