// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process stripping of personally identifiable information from telemetry.
 *
 * LiveKit marks attributes carrying conversational content, tool payloads, or other user data
 * with a dot-delimited `pii` segment (`lk.pii.<name>`), and the GenAI content attributes carry
 * the same kind of payload under names the semantic convention fixes, where the marker cannot
 * be applied.
 *
 * {@link PIIRedactingSpanProcessor} strips both before any exporter that is not LiveKit
 * Cloud's, whose own handling is the project's setting in the dashboard rather than ours to
 * second-guess. {@link restorePii} puts the payload back on that one export path.
 */
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span as SdkSpan, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { REDACTED_EXCEPTION_MESSAGE, stashPii } from './redaction.js';
import * as traceTypes from './trace_types.js';
import { redactionEnabled } from './utils.js';

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
 * Exception details are recorded by `recordException`, which resolves the project's redaction
 * setting; a third-party exporter must not see them either way.
 */
const REDACTED_EXCEPTION_ATTRIBUTES: ReadonlySet<string> = new Set([
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

/** Returns `attributes` without any PII entry, and with exception details removed. */
export function redactAttributes<T extends Record<string, unknown>>(attributes: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(attributes)) {
    if (isPIIAttribute(key) || key === traceTypes.ATTR_EXCEPTION_TRACE) continue;
    if (key === traceTypes.ATTR_EXCEPTION_MESSAGE) {
      // `error.type` still names the class; only the free-form message goes
      out[key] = REDACTED_EXCEPTION_MESSAGE;
      continue;
    }
    out[key] = attributes[key];
  }
  return out as Partial<T>;
}

/**
 * Strips PII so it never reaches an exporter that is not LiveKit Cloud's.
 *
 * Runs in `onEnding`, which the SDK dispatches to every registered processor *before* any
 * processor's `onEnd` and while the span is still mutable. Registration order therefore does
 * not matter: an exporter the integrator attached before LiveKit's own still sees the
 * redacted span.
 *
 * `allowPii` lifts the stripping for a provider whose exporters the integrator has explicitly
 * granted PII (`setTracerProvider(provider, { allowPii: true })`). The project's redaction
 * setting overrides that grant and strips for every destination, Cloud included.
 */
export class PIIRedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly allowPii: boolean = false) {}

  onStart(_span: SdkSpan, _parentContext: Context): void {}

  onEnding(span: SdkSpan): void {
    const projectRedaction = redactionEnabled(span.attributes);
    if (this.allowPii && !projectRedaction) return;

    const attributes = span.attributes as Record<string, unknown>;
    const events = span.events;
    const piiKeys = Object.keys(attributes).filter(
      (key) => isPIIAttribute(key) || REDACTED_EXCEPTION_ATTRIBUTES.has(key),
    );
    const contentEvents = events.filter((event) => PII_EVENT_NAMES.has(event.name));
    if (!piiKeys.length && !contentEvents.length) return;

    if (!projectRedaction) {
      // LiveKit Cloud still receives what the project allows
      stashPii(span);
    }

    for (const key of piiKeys) {
      if (key === traceTypes.ATTR_EXCEPTION_MESSAGE) {
        attributes[key] = REDACTED_EXCEPTION_MESSAGE;
      } else {
        delete attributes[key];
      }
    }

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
