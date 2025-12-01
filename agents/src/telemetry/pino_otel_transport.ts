// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom Pino OTEL Transport
 *
 * This module provides utilities to forward Pino logs to the OTEL LoggerProvider
 * using structured log objects (not raw JSON parsing).
 */
import type { AnyValue, AnyValueMap, Logger } from '@opentelemetry/api-logs';
import { SeverityNumber, logs } from '@opentelemetry/api-logs';

/**
 * Structured Pino log object passed to formatters.
 */
export interface PinoLogObject {
  level: number;
  time: number;
  msg?: string;
  pid?: number;
  hostname?: string;
  [key: string]: unknown;
}

/**
 * Map Pino log levels to OTEL SeverityNumber.
 *
 * Pino levels: trace=10, debug=20, info=30, warn=40, error=50, fatal=60
 * OTEL SeverityNumber: TRACE=1-4, DEBUG=5-8, INFO=9-12, WARN=13-16, ERROR=17-20, FATAL=21-24
 */
function mapPinoLevelToSeverity(pinoLevel: number): {
  severityNumber: SeverityNumber;
  severityText: string;
} {
  if (pinoLevel <= 10) {
    return { severityNumber: SeverityNumber.TRACE, severityText: 'trace' };
  } else if (pinoLevel <= 20) {
    return { severityNumber: SeverityNumber.DEBUG, severityText: 'debug' };
  } else if (pinoLevel <= 30) {
    return { severityNumber: SeverityNumber.INFO, severityText: 'info' };
  } else if (pinoLevel <= 40) {
    return { severityNumber: SeverityNumber.WARN, severityText: 'warn' };
  } else if (pinoLevel <= 50) {
    return { severityNumber: SeverityNumber.ERROR, severityText: 'error' };
  } else {
    return { severityNumber: SeverityNumber.FATAL, severityText: 'fatal' };
  }
}

// Fields to exclude from OTEL attributes (standard Pino fields)
const EXCLUDE_FIELDS = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v']);

/**
 * OTEL logger emitter for Pino logs.
 * Uses structured log objects directly without JSON parsing.
 */
class OtelLogEmitter {
  private otelLogger: Logger;

  constructor() {
    this.otelLogger = logs.getLogger('pino');
  }

  /**
   * Emit a structured Pino log object to OTEL.
   */
  emit(logObj: PinoLogObject): void {
    const { severityNumber, severityText } = mapPinoLevelToSeverity(logObj.level);

    // Build attributes from log fields
    const attributes: AnyValueMap = {};

    if (logObj.pid !== undefined) {
      attributes['process.pid'] = logObj.pid as AnyValue;
    }
    if (logObj.hostname !== undefined) {
      attributes['host.name'] = logObj.hostname as AnyValue;
    }

    // Add all other fields as attributes
    for (const [key, value] of Object.entries(logObj)) {
      if (!EXCLUDE_FIELDS.has(key)) {
        if (typeof value === 'object' && value !== null) {
          attributes[key] = JSON.stringify(value);
        } else {
          attributes[key] = value as AnyValue;
        }
      }
    }

    // Emit to OTEL LoggerProvider (timestamp in nanoseconds)
    this.otelLogger.emit({
      body: logObj.msg || '',
      timestamp: logObj.time * 1_000_000,
      severityNumber,
      severityText,
      attributes,
    });
  }
}

let emitter: OtelLogEmitter | null = null;

/**
 * Get or create the OTEL log emitter singleton.
 */
function getEmitter(): OtelLogEmitter {
  if (!emitter) {
    emitter = new OtelLogEmitter();
  }
  return emitter;
}

/**
 * Emit a structured Pino log object to OTEL.
 * Call this from Pino's formatters.log hook to forward logs without JSON parsing.
 *
 * @example
 * ```typescript
 * const logger = pino({
 *   formatters: {
 *     log(obj) {
 *       emitToOtel(obj as PinoLogObject);
 *       return obj;
 *     }
 *   }
 * });
 * ```
 */
export function emitToOtel(logObj: PinoLogObject): void {
  getEmitter().emit(logObj);
}
