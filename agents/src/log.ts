// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger, TransportTargetOptions } from 'pino';
import { pino } from 'pino';

/** @internal */
export type LoggerOptions = {
  pretty: boolean;
  level?: string;
  /** OTLP endpoint for sending logs (enables pino-opentelemetry-transport) */
  otlpLogsEndpoint?: string;
  /** OTLP headers for auth */
  otlpHeaders?: Record<string, string>;
  /** Resource attributes for OTLP */
  otlpResourceAttributes?: Record<string, string>;
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
export const initializeLogger = ({
  pretty,
  level,
  otlpLogsEndpoint,
  otlpHeaders,
  otlpResourceAttributes,
}: LoggerOptions) => {
  loggerOptions = { pretty, level, otlpLogsEndpoint, otlpHeaders, otlpResourceAttributes };

  // Configure transport based on options
  let transport: TransportTargetOptions | undefined;

  if (otlpLogsEndpoint) {
    // Use OpenTelemetry transport to send logs to OTLP collector
    transport = {
      target: 'pino-opentelemetry-transport',
      options: {
        loggerName: 'livekit-agents',
        resourceAttributes: otlpResourceAttributes || {},
        logRecordProcessorOptions: [
          {
            processorType: 'batch',
            exporterType: 'otlp-log',
            exporterOptions: {
              url: otlpLogsEndpoint,
              headers: otlpHeaders || {},
            },
          },
        ],
      },
    };
    console.log(`✅ Pino configured with OTLP transport (endpoint: ${otlpLogsEndpoint})`);
  } else if (pretty) {
    // Use pretty transport for development
    transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
      },
    };
  }

  logger = pino(transport ? { transport } : {});

  if (level) {
    logger.level = level;
  }
};
