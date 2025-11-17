// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';

/**
 * Enable Pino instrumentation to send logs to OTEL.
 * This should be called before creating Pino loggers.
 *
 * Note: The official @opentelemetry/instrumentation-pino package automatically
 * detects and uses the global LoggerProvider from OpenTelemetry API.
 * Make sure LoggerProvider is registered before calling this.
 *
 * @returns PinoInstrumentation instance (can be used to disable later)
 *
 * @example
 * ```typescript
 * // After setupCloudTracer() which registers LoggerProvider:
 * enablePinoOTELInstrumentation();
 *
 * // Now all Pino logs will be sent to OTEL
 * const logger = pino();
 * logger.info('This log goes to OTEL');
 * ```
 */
export function enablePinoOTELInstrumentation(): PinoInstrumentation {
  const instrumentation = new PinoInstrumentation();
  instrumentation.enable();
  return instrumentation;
}
