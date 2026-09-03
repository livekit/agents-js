// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Attributes } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_REDACTION_ENABLED } from '../types.js';
import { PIIRedactingSpanProcessor, isPIIAttribute } from './pii.js';
import * as traceTypes from './trace_types.js';

// Pins the SDK-side guarantee: for a redaction-enabled session every PII attribute is
// gone before any exporter sees the span, not only before it reaches LiveKit Cloud.

const PII_ATTRS: Attributes = {
  [traceTypes.ATTR_CHAT_CTX]: '{"items": []}',
  [traceTypes.ATTR_USER_TRANSCRIPT]: 'my card number is 4111',
  [traceTypes.ATTR_GEN_AI_INPUT_MESSAGES]: '[{"role": "user"}]',
  [traceTypes.ATTR_GEN_AI_OUTPUT_MESSAGES]: '[{"role": "assistant"}]',
  [traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]: '[{"type": "text"}]',
  [traceTypes.ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]: '{"location": "Paris"}',
  [traceTypes.ATTR_GEN_AI_TOOL_CALL_RESULT]: '{"temp": 14}',
};
const SAFE_ATTRS: Attributes = {
  [traceTypes.ATTR_GEN_AI_OPERATION_NAME]: 'chat',
  [traceTypes.ATTR_GEN_AI_USAGE_INPUT_TOKENS]: 100,
  [traceTypes.ATTR_SPEECH_ID]: 'speech_1',
};

function emit(options: { redaction: boolean; exporterFirst?: boolean }) {
  const exporter = new InMemorySpanExporter();
  const exportProcessor = new SimpleSpanProcessor(exporter);
  const redactProcessor = new PIIRedactingSpanProcessor();
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

describe('PIIRedactingSpanProcessor', () => {
  it('strips PII attributes and content events when redaction is enabled', () => {
    const span = emit({ redaction: true });

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

  it('leaves everything in place without redaction', () => {
    const span = emit({ redaction: false });

    for (const [key, value] of Object.entries(PII_ATTRS)) {
      expect(span.attributes[key]).toEqual(value);
    }
    expect(span.events.map((e) => e.name)).toContain(traceTypes.EVENT_GEN_AI_USER_MESSAGE);
  });

  it('protects an exporter registered before it', () => {
    // onEnding runs for every processor before any onEnd, so ordering cannot leak PII
    expect(leaked(emit({ redaction: true, exporterFirst: true }).attributes)).toEqual([]);
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
