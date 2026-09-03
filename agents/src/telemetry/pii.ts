// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process stripping of personally identifiable information from telemetry.
 *
 * LiveKit marks attributes carrying conversational content, tool payloads, or other user data
 * with a dot-delimited `pii` segment (`lk.pii.<name>`), which PII-enabled projects have
 * stripped at the LiveKit Cloud collector. That only protects records that reach LiveKit
 * Cloud: an integrator's own exporter — Datadog, Langfuse, an OTLP collector — sees whatever
 * the SDK put on the span.
 *
 * The GenAI content attributes make the gap material, since the semantic convention fixes
 * their names and the `lk.pii.` marker cannot be applied to them. So
 * {@link PIIRedactingSpanProcessor} strips them here instead, while the span is still
 * mutable and before any processor's `onEnd` runs.
 */
import type { Attributes, Context } from '@opentelemetry/api';
import type { ReadableSpan, Span as SdkSpan, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { getJobContext } from '../job.js';
import { ATTRIBUTE_REDACTION_ENABLED } from '../types.js';
import * as traceTypes from './trace_types.js';

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
const PII_EVENT_NAMES: ReadonlySet<string> = new Set([
  traceTypes.EVENT_GEN_AI_SYSTEM_MESSAGE,
  traceTypes.EVENT_GEN_AI_USER_MESSAGE,
  traceTypes.EVENT_GEN_AI_ASSISTANT_MESSAGE,
  traceTypes.EVENT_GEN_AI_TOOL_MESSAGE,
  traceTypes.EVENT_GEN_AI_CHOICE,
  traceTypes.EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS,
]);

/**
 * Whether `key` names an attribute that must be stripped under redaction: it carries a
 * dot-delimited `pii` segment, or it is one of the GenAI content attributes.
 */
export function isPIIAttribute(key: string): boolean {
  if (PII_SEGMENT_RE.test(key)) return true;
  if (GEN_AI_PII_ATTRIBUTES.has(key)) return true;
  // gen_ai.prompt.variable.<key> holds the values interpolated into a prompt template
  return key.startsWith(traceTypes.ATTR_GEN_AI_PROMPT_VARIABLE);
}

/** Returns `attributes` without any PII entry. */
export function redactAttributes<T extends Record<string, unknown>>(attributes: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(attributes)) {
    if (!isPIIAttribute(key)) {
      out[key] = attributes[key];
    }
  }
  return out as Partial<T>;
}

/**
 * Whether the span belongs to a session that asked for redaction.
 *
 * Resolved from the span's own attributes first: the redaction flag is stamped at span start
 * by the metadata processor, so it stays correct for a span ended outside the job's async
 * context. Spans created before the job registered its recording options fall back to the
 * ambient job context.
 */
function spanRedactionEnabled(attributes: Attributes | undefined): boolean {
  if (attributes?.[ATTRIBUTE_REDACTION_ENABLED]) return true;
  return getJobContext(false)?._redactionEnabled ?? false;
}

/**
 * Strips PII attributes and content events from every span of a redaction-enabled session.
 *
 * Runs in `onEnding`, which the SDK dispatches to every registered processor *before* any
 * processor's `onEnd` and while the span is still mutable. Registration order therefore does
 * not matter: an exporter the integrator attached before LiveKit's own still sees the
 * redacted span.
 */
export class PIIRedactingSpanProcessor implements SpanProcessor {
  onStart(_span: SdkSpan, _parentContext: Context): void {}

  onEnding(span: SdkSpan): void {
    if (!spanRedactionEnabled(span.attributes)) return;

    for (const key of Object.keys(span.attributes)) {
      if (isPIIAttribute(key)) {
        delete (span.attributes as Record<string, unknown>)[key];
      }
    }

    const events = span.events;
    if (!events.length) return;

    const kept = events.filter((event) => !PII_EVENT_NAMES.has(event.name));
    for (const event of kept) {
      if (!event.attributes) continue;
      for (const key of Object.keys(event.attributes)) {
        if (isPIIAttribute(key)) {
          delete (event.attributes as Record<string, unknown>)[key];
        }
      }
    }
    if (kept.length !== events.length) {
      events.length = 0;
      events.push(...kept);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
