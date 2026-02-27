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

  globals[LOGGER_KEY] = pino(
    { level: logLevel, serializers: { error: pino.stdSerializers.err } },
    multistream(streams),
  );
};
