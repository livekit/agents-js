// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Attributes, SpanStatus } from '@opentelemetry/api';
import type { ReadableSpan, Span as SdkSpan, TimedEvent } from '@opentelemetry/sdk-trace-node';
import { ATTRIBUTE_REDACTION_ENABLED } from '../types.js';
import * as traceTypes from './trace_types.js';

// Type-only imports on purpose: this module is pulled in near the top of the telemetry
// barrel (via pino_otel_transport), which job.ts imports, so anything imported here starts
// evaluating that far earlier inside the job <-> telemetry cycle.

export const REDACTED_EXCEPTION_MESSAGE = 'exception details redacted';

/**
 * Mirrors the LiveKit Cloud collector's matcher: a whole dot-delimited `pii` segment,
 * case-insensitive (`lk.chatpii` does not match, `lk.PII.x` does).
 */
const PII_SEGMENT_RE = /(^|\.)pii(\.|$)/i;

/**
 * GenAI attributes that carry content. Their names are fixed by the semantic convention,
 * so they cannot carry the `lk.pii.` marker and are enumerated here instead.
 */
export const GEN_AI_PII_ATTRIBUTES: ReadonlySet<string> = new Set([
  // flagged "likely to contain sensitive information including user/PII data" by the spec
  traceTypes.ATTR_GEN_AI_INPUT_MESSAGES,
  traceTypes.ATTR_GEN_AI_OUTPUT_MESSAGES,
  traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  traceTypes.ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  traceTypes.ATTR_GEN_AI_TOOL_CALL_RESULT,
  traceTypes.ATTR_GEN_AI_TOOL_DESCRIPTION,
  traceTypes.ATTR_GEN_AI_TOOL_DEFINITIONS,
  // free-form text the caller supplied or the model produced
  traceTypes.ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT,
  traceTypes.ATTR_GEN_AI_RETRIEVAL_DOCUMENTS,
  traceTypes.ATTR_GEN_AI_MEMORY_QUERY_TEXT,
  traceTypes.ATTR_GEN_AI_MEMORY_RECORDS,
  traceTypes.ATTR_GEN_AI_EVALUATION_EXPLANATION,
]);

/**
 * Events whose body rides on a generic attribute (`content`, `tool_calls`) that cannot be
 * marked, so the whole event is dropped rather than filtered.
 */
export const PII_EVENT_NAMES: ReadonlySet<string> = new Set([
  traceTypes.EVENT_GEN_AI_SYSTEM_MESSAGE,
  traceTypes.EVENT_GEN_AI_USER_MESSAGE,
  traceTypes.EVENT_GEN_AI_ASSISTANT_MESSAGE,
  traceTypes.EVENT_GEN_AI_TOOL_MESSAGE,
  traceTypes.EVENT_GEN_AI_CHOICE,
  traceTypes.EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS,
]);

/**
 * Exception details are recorded by `recordException`, which resolves the project's redaction
 * setting; a third-party exporter must not see them either way.
 */
export const REDACTED_EXCEPTION_ATTRIBUTES: ReadonlySet<string> = new Set([
  traceTypes.ATTR_EXCEPTION_MESSAGE,
  traceTypes.ATTR_EXCEPTION_TRACE,
]);

/**
 * Whether `key` names an attribute that must be stripped: it carries a dot-delimited `pii`
 * segment, or it is one of the GenAI content attributes.
 */
export function isPIIAttribute(key: string): boolean {
  if (PII_SEGMENT_RE.test(key)) return true;
  if (GEN_AI_PII_ATTRIBUTES.has(key)) return true;
  // gen_ai.prompt.variable.<key> holds the values interpolated into a prompt template
  return key.startsWith(traceTypes.ATTR_GEN_AI_PROMPT_VARIABLE);
}

const ALLOW_PII_ENV_VAR = 'LIVEKIT_TELEMETRY_ALLOW_PII';
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * The `LIVEKIT_TELEMETRY_ALLOW_PII` setting, or `undefined` when unset.
 *
 * For integrators who let the framework adopt the ambient OpenTelemetry provider (a
 * NodeSDK-style setup) and so have nowhere to pass `allowPii`. Set it to `0` to withhold
 * conversational content from third-party exporters.
 */
/**
 * Whether the record's own stamp says the project mandated redaction.
 *
 * Attribute-only on purpose: the modules that need this sit at the top of the telemetry
 * barrel, which job.ts imports, so they cannot reach the ambient job context. The stamp is
 * applied to every record by the metadata processor.
 */
export function redactionEnabledFromAttributes(
  // loose on purpose: span attributes and log attributes are different OTel types
  attributes: Record<string, unknown> | undefined,
): boolean {
  return Boolean(attributes?.[ATTRIBUTE_REDACTION_ENABLED]);
}

export function allowPiiFromEnv(): boolean | undefined {
  const raw = process.env[ALLOW_PII_ENV_VAR];
  if (raw === undefined) return undefined;
  return !FALSY.has(raw.trim().toLowerCase());
}

const RAW_ATTRIBUTES = Symbol('lkRawAttributes');
const RAW_EVENTS = Symbol('lkRawEvents');
const RAW_STATUS = Symbol('lkRawStatus');

interface PiiStash {
  [RAW_ATTRIBUTES]?: Attributes;
  [RAW_EVENTS]?: TimedEvent[];
  [RAW_STATUS]?: SpanStatus;
}

/** Keeps the pre-filter payload for {@link restorePii} to hand LiveKit Cloud. */
export function stashPii(span: SdkSpan): void {
  const stash = span as unknown as PiiStash;
  stash[RAW_ATTRIBUTES] = { ...span.attributes };
  stash[RAW_EVENTS] = span.events.map((event) => ({
    ...event,
    attributes: { ...event.attributes },
  }));
  stash[RAW_STATUS] = { ...span.status };
}

/**
 * The span as it was before PII was stripped for third-party exporters.
 *
 * Only LiveKit Cloud's own exporter calls this; every other destination sees the redacted
 * span. Returns `span` unchanged when nothing was stashed.
 *
 * The view delegates to the span through its prototype so the getters `ReadableSpan` relies
 * on keep working, with only `attributes` and `events` shadowed.
 */
export function restorePii(span: ReadableSpan): ReadableSpan {
  const stash = span as unknown as PiiStash;
  const attributes = stash[RAW_ATTRIBUTES];
  if (!attributes) return span;

  const view = Object.create(span) as ReadableSpan;
  Object.defineProperty(view, 'attributes', { value: attributes, enumerable: true });
  Object.defineProperty(view, 'events', {
    value: stash[RAW_EVENTS] ?? span.events,
    enumerable: true,
  });
  Object.defineProperty(view, 'status', {
    value: stash[RAW_STATUS] ?? span.status,
    enumerable: true,
  });
  return view;
}
