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
    { level: level || 'info' },
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
  if (otelEnabled || !logger) {
    console.warn('OTEL logging already enabled or logger not initialized');
    return;
  }
  otelEnabled = true;

  const { pretty, level } = loggerOptions;

  const logLevel = level || 'info';
  const streams: { stream: DestinationStream; level: string }[] = [
    { stream: pretty ? pinoPretty({ colorize: true }) : process.stdout, level: logLevel },
    { stream: new OtelDestination(), level: 'debug' },
  ];

  logger = pino({ level: logLevel }, multistream(streams));
};
