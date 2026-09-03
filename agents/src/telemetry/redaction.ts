// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan, Span as SdkSpan, TimedEvent } from '@opentelemetry/sdk-trace-node';

// Type-only imports on purpose: this module is pulled in near the top of the telemetry
// barrel (via pino_otel_transport), which job.ts imports, so anything imported here starts
// evaluating that far earlier inside the job <-> telemetry cycle.

export const REDACTED_EXCEPTION_MESSAGE = 'exception details redacted';

const ALLOW_PII_ENV_VAR = 'LIVEKIT_TELEMETRY_ALLOW_PII';
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * The `LIVEKIT_TELEMETRY_ALLOW_PII` setting, or `undefined` when unset.
 *
 * For integrators who let the framework adopt the ambient OpenTelemetry provider (a
 * NodeSDK-style setup) and so have nowhere to pass `allowPii`. Set it to `0` to withhold
 * conversational content from third-party exporters.
 */
export function allowPiiFromEnv(): boolean | undefined {
  const raw = process.env[ALLOW_PII_ENV_VAR];
  if (raw === undefined) return undefined;
  return !FALSY.has(raw.trim().toLowerCase());
}

const RAW_ATTRIBUTES = Symbol('lkRawAttributes');
const RAW_EVENTS = Symbol('lkRawEvents');

interface PiiStash {
  [RAW_ATTRIBUTES]?: Attributes;
  [RAW_EVENTS]?: TimedEvent[];
}

/** Keeps the pre-redaction payload for {@link restorePii} to hand LiveKit Cloud. */
export function stashPii(span: SdkSpan): void {
  const stash = span as unknown as PiiStash;
  stash[RAW_ATTRIBUTES] = { ...span.attributes };
  stash[RAW_EVENTS] = [...span.events];
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
  return view;
}
