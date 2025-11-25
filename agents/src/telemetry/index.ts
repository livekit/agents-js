// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export { ExtraDetailsProcessor, MetadataLogProcessor } from './logging.js';
export {
  OTLPHttpLogExporter,
  SeverityNumber,
  SimpleOTLPHttpLogExporter,
  type OTLPHttpLogExporterConfig,
  type SimpleLogRecord,
  type SimpleOTLPHttpLogExporterConfig,
} from './otel_http_exporter.js';
export { enablePinoOTELInstrumentation } from './pino_bridge.js';
export * as traceTypes from './trace_types.js';
export {
  setTracerProvider,
  setupCloudTracer,
  tracer,
  uploadSessionReport,
  type StartSpanOptions,
} from './traces.js';
export { recordException, recordRealtimeMetrics } from './utils.js';
