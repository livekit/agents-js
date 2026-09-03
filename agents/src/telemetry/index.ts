// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export { ExtraDetailsProcessor, MetadataLogProcessor } from './logging.js';
export type { ObservabilityEndpoint } from './observability_endpoint.js';
export {
  SimpleOTLPHttpLogExporter,
  type SimpleLogRecord,
  type SimpleOTLPHttpLogExporterConfig,
  type SimpleOTLPHttpLogExporterUrlConfig,
} from './otel_http_exporter.js';
export {
  emitToOtel,
  flushPinoLogs,
  initPinoCloudExporter,
  PinoCloudExporter,
  type PinoCloudExporterConfig,
  type PinoCloudExporterUrlConfig,
  type PinoLogObject,
} from './pino_otel_transport.js';
export * as genAI from './gen_ai.js';
export { PIIRedactingSpanProcessor, isPIIAttribute, redactAttributes } from './pii.js';
export * as traceTypes from './trace_types.js';
export {
  FanoutSpanProcessor,
  flushOtelLogs,
  setTracerProvider,
  setupCloudTracer,
  tracer,
  uploadSessionReport,
  type CloudSpanProcessorOptions,
  type SetTracerProviderOptions,
  type SpanProcessorLike,
  type StartSpanOptions,
} from './traces.js';
export {
  REDACTED_EXCEPTION_MESSAGE,
  recordException,
  recordRealtimeMetrics,
  type RecordExceptionOptions,
} from './utils.js';
