// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Attributes } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_REDACTION_ENABLED } from '../types.js';
import { PIIFilteringSpanProcessor, isPIIAttribute } from './pii.js';
import { restorePii } from './redaction.js';
import * as traceTypes from './trace_types.js';

// Pins the SDK-side guarantee: PII never reaches an exporter that is not LiveKit Cloud's,
// whose own handling is the project's setting in the dashboard. `allowPii` lifts that per
// provider; the project flag overrides it and strips for every destination.

const PII_ATTRS: Attributes = {
  [traceTypes.ATTR_CHAT_CTX]: '{"items": []}',
  [traceTypes.ATTR_USER_TRANSCRIPT]: 'my card number is 4111',
  [traceTypes.ATTR_GEN_AI_INPUT_MESSAGES]: '[{"role": "user"}]',
  [traceTypes.ATTR_GEN_AI_OUTPUT_MESSAGES]: '[{"role": "assistant"}]',
  [traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]: '[{"type": "text"}]',
  [traceTypes.ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]: '{"location": "Paris"}',
  [traceTypes.ATTR_GEN_AI_TOOL_CALL_RESULT]: '{"temp": 14}',
  // free-form, and recorded whenever the project allows it
  [traceTypes.ATTR_EXCEPTION_TRACE]: 'Traceback: "my pin is 1234"',
};
const SAFE_ATTRS: Attributes = {
  [traceTypes.ATTR_GEN_AI_OPERATION_NAME]: 'chat',
  [traceTypes.ATTR_GEN_AI_USAGE_INPUT_TOKENS]: 100,
  [traceTypes.ATTR_SPEECH_ID]: 'speech_1',
};

function emit(options: { redaction?: boolean; exporterFirst?: boolean; allowPii?: boolean }) {
  const exporter = new InMemorySpanExporter();
  const exportProcessor = new SimpleSpanProcessor(exporter);
  const redactProcessor = new PIIFilteringSpanProcessor(options.allowPii ?? true);
  const provider = new BasicTracerProvider({
    spanProcessors: options.exporterFirst
      ? [exportProcessor, redactProcessor]
      : [redactProcessor, exportProcessor],
  });

  const span = provider.getTracer('test').startSpan('llm_request');
  if (options.redaction) span.setAttribute(ATTRIBUTE_REDACTION_ENABLED, true);
  span.setAttributes({ ...PII_ATTRS, ...SAFE_ATTRS });
  span.addEvent(traceTypes.EVENT_GEN_AI_USER_MESSAGE, { content: 'my pin is 1234' });
  span.addEvent('llm_started', { [traceTypes.ATTR_INSTRUCTIONS]: 'be brief', n: 1 });
  span.end();

  return exporter.getFinishedSpans()[0]!;
}

function leaked(attributes: Attributes): string[] {
  return Object.keys(PII_ATTRS).filter((key) => key in attributes);
}

describe('PIIFilteringSpanProcessor', () => {
  it('withholds PII from third-party exporters on request', () => {
    const span = emit({ allowPii: false });

    expect(leaked(span.attributes)).toEqual([]);
    for (const [key, value] of Object.entries(SAFE_ATTRS)) {
      expect(span.attributes[key]).toEqual(value);
    }

    const events = Object.fromEntries(span.events.map((e) => [e.name, e.attributes ?? {}]));
    // the GenAI content events carry the body in a generic `content` attribute that
    // cannot be marked, so the whole event goes
    expect(events[traceTypes.EVENT_GEN_AI_USER_MESSAGE]).toBeUndefined();
    // a non-content event keeps its safe attributes and loses its PII ones
    expect(events['llm_started']).toEqual({ n: 1 });
  });

  it('lets exporters receive PII by default', () => {
    // the GenAI conventions are only useful to a backend that can render the conversation
    const span = emit({});

    for (const [key, value] of Object.entries(PII_ATTRS)) {
      expect(span.attributes[key]).toEqual(value);
    }
    expect(span.events.map((e) => e.name)).toContain(traceTypes.EVENT_GEN_AI_USER_MESSAGE);
  });

  it('still hands LiveKit Cloud the PII the project allows', () => {
    const stripped = emit({ allowPii: false });
    const restored = restorePii(stripped);

    for (const [key, value] of Object.entries(PII_ATTRS)) {
      expect(restored.attributes[key]).toEqual(value);
    }
    expect(restored.events.map((e) => e.name)).toContain(traceTypes.EVENT_GEN_AI_USER_MESSAGE);
    // the view must not lose the getters ReadableSpan relies on
    expect(restored.spanContext().spanId).toBe(stripped.spanContext().spanId);
    expect(restored.name).toBe(stripped.name);
  });

  it('withholds PII from every destination when the project mandates redaction', () => {
    // redaction mandated in the dashboard is not weakened by a local grant, and nothing is
    // stashed for LiveKit Cloud to restore
    const stripped = emit({ allowPii: true, redaction: true });

    expect(leaked(stripped.attributes)).toEqual([]);
    expect(restorePii(stripped)).toBe(stripped);
  });

  it('withholds exception details from third-party exporters', () => {
    // recordException resolves the project's setting, so with redaction off it writes the
    // real message onto the span, its `exception` event and the span status
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new PIIFilteringSpanProcessor(false), new SimpleSpanProcessor(exporter)],
    });
    const span = provider.getTracer('test').startSpan('llm_request');
    span.recordException(new Error('my pin is 1234'));
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'my pin is 1234' });
    span.end();

    const exported = exporter.getFinishedSpans()[0]!;
    const serialized = JSON.stringify([
      exported.attributes,
      exported.events.map((e) => e.attributes),
      exported.status.message,
    ]);
    expect(serialized).not.toContain('my pin is 1234');
  });

  it('protects an exporter registered before it', () => {
    // onEnding runs for every processor before any onEnd, so ordering cannot leak PII
    expect(leaked(emit({ allowPii: false, exporterFirst: true }).attributes)).toEqual([]);
  });

  it.each([
    ['lk.pii.chat_ctx', true],
    ['gen_ai.input.messages', true],
    ['gen_ai.prompt.variable.customer_name', true],
    ['gen_ai.usage.input_tokens', false],
    // a `pii` substring is not a `pii` segment
    ['lk.piidata.x', false],
  ])('classifies %s', (key, expected) => {
    expect(isPIIAttribute(key as string)).toBe(expected);
  });
});
