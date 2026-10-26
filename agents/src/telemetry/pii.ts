// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process stripping of personally identifiable information from telemetry.
 *
 * Field-level filtering, not entity-level redaction: a matching attribute is dropped whole,
 * never scanned and masked. "Redaction" in this codebase means the project setting (LiveKit
 * Cloud dashboard, or `record: { redaction: true }`); this module is what the client does
 * about it.
 *
 * LiveKit marks attributes carrying conversational content, tool payloads, or other user data
 * with a dot-delimited `pii` segment (`lk.pii.<name>`), and the GenAI content attributes carry
 * the same kind of payload under names the semantic convention fixes, where the marker cannot
 * be applied. Both are filtered before any exporter that is not LiveKit Cloud's — and before
 * every exporter, Cloud included, once the project has enabled redaction, so the client never
 * depends on a collector to strip a new key. {@link restorePii} puts the payload back on
 * LiveKit Cloud's export path when the project still allows it.
 */
import type { Context } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, Span as SdkSpan, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import {
  PII_EVENT_NAMES,
  REDACTED_EXCEPTION_ATTRIBUTES,
  REDACTED_EXCEPTION_MESSAGE,
  isPIIAttribute,
  stashPii,
} from './redaction.js';
import * as traceTypes from './trace_types.js';
import { redactionEnabled } from './utils.js';

/**
 * Drops PII attributes so they never reach an exporter that is not LiveKit Cloud's.
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
export class PIIFilteringSpanProcessor implements SpanProcessor {
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
    const kept = events.filter((event) => !PII_EVENT_NAMES.has(event.name));
    const eventCarriesPii = kept.some((event) =>
      Object.keys(event.attributes ?? {}).some(
        (key) => isPIIAttribute(key) || REDACTED_EXCEPTION_ATTRIBUTES.has(key),
      ),
    );
    if (!piiKeys.length && kept.length === events.length && !eventCarriesPii) {
      if (span.status.code !== SpanStatusCode.ERROR || !span.status.message) return;
    }

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

    for (const event of kept) {
      const attrs = event.attributes as Record<string, unknown> | undefined;
      for (const key of Object.keys(attrs ?? {})) {
        if (key === traceTypes.ATTR_EXCEPTION_MESSAGE) {
          attrs![key] = REDACTED_EXCEPTION_MESSAGE;
        } else if (isPIIAttribute(key) || REDACTED_EXCEPTION_ATTRIBUTES.has(key)) {
          delete attrs![key];
        }
      }
    }
    if (kept.length !== events.length) {
      events.length = 0;
      events.push(...kept);
    }

    // recordException also puts the message in the span status. setStatus still applies
    // here: the SDK marks the span ended only after onEnding returns.
    if (span.status.code === SpanStatusCode.ERROR && span.status.message) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: REDACTED_EXCEPTION_MESSAGE });
    }
  }

  onEnd(_span: ReadableSpan): void {}

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
