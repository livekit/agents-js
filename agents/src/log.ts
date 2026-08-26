// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Writable } from 'node:stream';
import type { DestinationStream, Logger } from 'pino';
import { multistream, pino } from 'pino';
import { build as pinoPretty } from 'pino-pretty';
import { type LoggerOptions, log, loggerOptions, setLoggerState } from './log_core.js';
import { type PinoLogObject, emitToOtel } from './telemetry/pino_otel_transport.js';

const OTEL_ENABLED_KEY = Symbol.for('@livekit/agents:otelEnabled');

type GlobalState = {
  [OTEL_ENABLED_KEY]?: boolean;
};

const globals = globalThis as typeof globalThis & GlobalState;

// LiveKit Cloud injects this into deployed agents. Child processes inherit it.
const deployedRegion = process.env.LIVEKIT_REGION_NAME || undefined;

export { log, loggerOptions, type LoggerOptions };

const createLogger = ({ pretty, level }: LoggerOptions): Logger => {
  const logLevel = level || 'info';
  const streams: { stream: DestinationStream; level: string }[] = [
    { stream: pretty ? pinoPretty({ colorize: true }) : process.stdout, level: logLevel },
    { stream: new OtelDestination(), level: 'debug' },
  ];

  return pino(
    {
      level: logLevel,
      serializers: { error: pino.stdSerializers.err },
      ...(deployedRegion && { mixin: () => ({ region: deployedRegion }) }),
    },
    multistream(streams),
  );
};

/** @internal */
export const initializeLogger = ({ pretty, level }: LoggerOptions) => {
  const options = { pretty, level };
  setLoggerState(createLogger(options), options);
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
  if (globals[OTEL_ENABLED_KEY] || !loggerOptions()) {
    console.warn('OTEL logging already enabled or logger not initialized');
    return;
  }
  globals[OTEL_ENABLED_KEY] = true;
};
