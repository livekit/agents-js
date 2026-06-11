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
  compact?: boolean;
};

// Use Symbol.for() + globalThis to create process-wide singletons.
// This avoids the "dual package hazard". Symbol.for() returns the same Symbol
// across all module instances, and globalThis is shared process-wide.
const LOGGER_KEY = Symbol.for('@livekit/agents:logger');
const LOGGER_OPTIONS_KEY = Symbol.for('@livekit/agents:loggerOptions');
const OTEL_ENABLED_KEY = Symbol.for('@livekit/agents:otelEnabled');

type GlobalState = {
  [LOGGER_KEY]?: Logger;
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

const createLogger = ({ pretty, level, compact }: LoggerOptions): Logger => {
  const logLevel = level || 'info';
  const streams: { stream: DestinationStream; level: string }[] = [
    {
      stream: pretty ? pinoPretty({ colorize: true, singleLine: compact }) : process.stdout,
      level: logLevel,
    },
    { stream: new OtelDestination(), level: 'debug' },
  ];

  return pino(
    { level: logLevel, serializers: { error: pino.stdSerializers.err } },
    multistream(streams),
  );
};

/** @internal */
export const initializeLogger = ({ pretty, level, compact }: LoggerOptions) => {
  globals[LOGGER_OPTIONS_KEY] = { pretty, level, compact };
  globals[LOGGER_KEY] = createLogger({ pretty, level, compact });
};

/**
 * Custom Pino destination that parses JSON logs and emits to OTEL.
 * This receives the FULL serialized log including msg, level, time, etc.
 */
class OtelDestination extends Writable {
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    try {
      if (!globals[OTEL_ENABLED_KEY]) {
        callback();
        return;
      }

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
 * Enable OTEL logging for the existing logger streams.
 *
 * @internal
 */
export const enableOtelLogging = () => {
  if (globals[OTEL_ENABLED_KEY] || !globals[LOGGER_KEY]) {
    console.warn('OTEL logging already enabled or logger not initialized');
    return;
  }
  globals[OTEL_ENABLED_KEY] = true;
};
