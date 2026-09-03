// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Attributes } from '@opentelemetry/api';
import { type Span, SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api';
import { getJobContext } from '../job.js';
import type { RealtimeModelMetrics } from '../metrics/base.js';
import { ATTRIBUTE_REDACTION_ENABLED } from '../types.js';
import { realtimeUsageAttributes, setErrorType } from './gen_ai.js';
import { REDACTED_EXCEPTION_MESSAGE } from './redaction.js';
import * as traceTypes from './trace_types.js';
import { tracer } from './traces.js';

/**
 * Whether the project has mandated PII redaction.
 *
 * Set in the LiveKit Cloud dashboard (or per session with `record: { redaction: true }`) and
 * never weakened from here — when it is on, PII is stripped for every destination, LiveKit
 * Cloud included. `spanAttributes` lets a span ended outside the job's async context resolve
 * from the flag stamped on it at span start.
 *
 * Stripping PII for *third-party* exporters is not this flag: that is the default, and is
 * lifted per provider with `setTracerProvider(provider, { allowPii: true })`.
 */
export function redactionEnabled(spanAttributes?: Attributes): boolean {
  if (spanAttributes?.[ATTRIBUTE_REDACTION_ENABLED]) return true;
  return getJobContext(false)?._redactionEnabled ?? false;
}

export { REDACTED_EXCEPTION_MESSAGE } from './redaction.js';

export interface RecordExceptionOptions {
  /**
   * Whether to omit exception messages and stack traces from telemetry. Defaults to the resolved
   * redaction setting for the current session.
   */
  redacted?: boolean;
}

export function recordException(
  span: Span,
  error: Error,
  options: RecordExceptionOptions = {},
): void {
  const redacted = options.redacted ?? redactionEnabled();

  // `error.type` is the GenAI/HTTP conventions' low-cardinality error identifier; unlike the
  // message it never carries user data, so it is set either way
  setErrorType(span, error);

  if (redacted) {
    const attrs = {
      [traceTypes.ATTR_EXCEPTION_TYPE]: error.constructor.name,
      [traceTypes.ATTR_EXCEPTION_MESSAGE]: REDACTED_EXCEPTION_MESSAGE,
    };
    span.addEvent('exception', attrs);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: REDACTED_EXCEPTION_MESSAGE,
    });
    span.setAttributes(attrs);
    return;
  }

  span.recordException(error);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  });

  // Set exception attributes for better visibility
  // (in case the exception event is not rendered by the backend)
  span.setAttributes({
    [traceTypes.ATTR_EXCEPTION_TYPE]: error.constructor.name,
    [traceTypes.ATTR_EXCEPTION_MESSAGE]: error.message,
    [traceTypes.ATTR_EXCEPTION_TRACE]: error.stack || '',
  });
}

export function recordRealtimeMetrics(span: Span, metrics: RealtimeModelMetrics): void {
  const attrs: Record<string, string | number | boolean> = {
    // a realtime turn is a multimodal generation; `gen_ai.output.type` is set on the
    // inference span, which knows whether this session outputs audio
    [traceTypes.ATTR_GEN_AI_OPERATION_NAME]: traceTypes.GenAIOperationName.GENERATE_CONTENT,
    [traceTypes.ATTR_REALTIME_MODEL_METRICS]: JSON.stringify(metrics),
    ...(realtimeUsageAttributes(metrics) as Record<string, number>),
    // unofficial spellings LangFuse reads, kept alongside the official ones
    [traceTypes.ATTR_GEN_AI_USAGE_INPUT_TEXT_TOKENS]: metrics.inputTokenDetails.textTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_INPUT_AUDIO_TOKENS]: metrics.inputTokenDetails.audioTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_INPUT_CACHED_TOKENS]: metrics.inputTokenDetails.cachedTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_OUTPUT_TEXT_TOKENS]: metrics.outputTokenDetails.textTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_OUTPUT_AUDIO_TOKENS]: metrics.outputTokenDetails.audioTokens,
  };

  // `metrics.label` names the plugin, not the model, so it is never reported as one
  const modelName = metrics.metadata?.modelName;
  if (modelName) {
    attrs[traceTypes.ATTR_GEN_AI_REQUEST_MODEL] = modelName;
    attrs[traceTypes.ATTR_GEN_AI_RESPONSE_MODEL] = modelName;
  }
  const provider = traceTypes.genAIProviderName(metrics.metadata?.modelProvider);
  if (provider) attrs[traceTypes.ATTR_GEN_AI_PROVIDER_NAME] = provider;
  if (metrics.requestId) attrs[traceTypes.ATTR_GEN_AI_RESPONSE_ID] = metrics.requestId;
  if (metrics.ttftMs !== undefined && metrics.ttftMs >= 0) {
    attrs[traceTypes.ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK] = metrics.ttftMs / 1000;
  }

  // Add LangFuse-specific completion start time if TTFT is available
  if (metrics.ttftMs !== undefined && metrics.ttftMs !== -1) {
    const completionStartTime = metrics.timestamp + metrics.ttftMs;
    // Convert to UTC ISO string for LangFuse compatibility
    const completionStartTimeUtc = new Date(completionStartTime).toISOString();
    attrs[traceTypes.ATTR_LANGFUSE_COMPLETION_START_TIME] = completionStartTimeUtc;
  }

  if (span.isRecording()) {
    span.setAttributes(attrs);
  } else {
    const currentContext = otelContext.active();
    const spanContext = trace.setSpan(currentContext, span);

    // Create a dedicated child span for orphaned metrics
    tracer.getTracer().startActiveSpan('realtime_metrics', {}, spanContext, (child) => {
      try {
        child.setAttributes(attrs);
      } finally {
        child.end();
      }
    });
  }
}
