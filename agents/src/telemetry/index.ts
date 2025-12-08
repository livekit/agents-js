// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export { ExtraDetailsProcessor, MetadataLogProcessor } from './logging.js';
export {
  SimpleOTLPHttpLogExporter,
  type SimpleLogRecord,
  type SimpleOTLPHttpLogExporterConfig,
} from './otel_http_exporter.js';
export {
  emitToOtel,
  flushPinoLogs,
  initPinoCloudExporter,
  PinoCloudExporter,
  type PinoCloudExporterConfig,
  type PinoLogObject,
} from './pino_otel_transport.js';
export * as traceTypes from './trace_types.js';
export {
  flushOtelLogs,
  setTracerProvider,
  setupCloudTracer,
  tracer,
  uploadSessionReport,
  type StartSpanOptions,
} from './traces.js';
export { recordException, recordRealtimeMetrics } from './utils.js';
