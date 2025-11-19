// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// TODO(brian): PR5 - Add uploadSessionReport export

export { ExtraDetailsProcessor, MetadataLogProcessor } from './logging.js';
export * as traceTypes from './trace_types.js';
export {
  setTracerProvider,
  setupCloudTracer,
  tracer,
  uploadSessionReport,
  type StartSpanOptions,
} from './traces.js';
export { recordException, recordRealtimeMetrics } from './utils.js';
