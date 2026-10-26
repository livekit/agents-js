// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Attributes, Span } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type JobContext, runWithJobContext } from '../job.js';
import * as genAI from './gen_ai.js';
import { setTracerProvider, tracer } from './traces.js';

const APIs = ['startSpan', 'startActiveSpan', 'startActiveSpanSync', 'detachedSpan'] as const;
type TracerApi = (typeof APIs)[number];

function inConversation<T>(conversationId: string | undefined, fn: () => T): T {
  if (!conversationId) return fn();
  return runWithJobContext({ job: { room: { sid: conversationId } } } as unknown as JobContext, fn);
}

async function withSpan(
  api: TracerApi,
  attributes: Attributes | undefined,
  fn: (span: Span) => void,
): Promise<void> {
  const options = { name: 'test', attributes };
  if (api === 'startSpan') {
    const span = tracer.startSpan(options);
    try {
      fn(span);
    } finally {
      span.end();
    }
  } else if (api === 'startActiveSpan') {
    await tracer.startActiveSpan(async (span) => fn(span), options);
  } else if (api === 'startActiveSpanSync') {
    tracer.startActiveSpanSync(fn, options);
  } else {
    await tracer.detachedSpan(async (span) => fn(span), options);
  }
}

describe.sequential('telemetry conversation id', () => {
  let originalProvider = tracer.getProvider();
  let provider: NodeTracerProvider;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    setTracerProvider(provider);
  });

  afterEach(async () => {
    setTracerProvider(originalProvider);
    await provider.shutdown();
  });

  it.each(
    APIs.flatMap((api) =>
      [undefined, 'RM_test'].flatMap((conversationId) =>
        [undefined, 'explicit'].map((explicitId) => ({ api, conversationId, explicitId })),
      ),
    ),
  )(
    '$api preserves caller attributes with conversation=$conversationId explicit=$explicitId',
    async ({ api, conversationId, explicitId }) => {
      const attributes = Object.freeze({
        'test.attribute': 'value',
        ...(explicitId ? { 'gen_ai.conversation.id': explicitId } : {}),
      });
      const original = { ...attributes };

      await inConversation(conversationId, () => withSpan(api, attributes, () => undefined));

      expect(attributes).toEqual(original);
      expect(exporter.getFinishedSpans()[0]!.attributes).toEqual({
        ...original,
        ...(!explicitId && conversationId ? { 'gen_ai.conversation.id': conversationId } : {}),
      });
    },
  );

  it.each(APIs)('%s adds the conversation id when attributes are absent', async (api) => {
    await inConversation('RM_test', () => withSpan(api, undefined, () => undefined));

    expect(exporter.getFinishedSpans()[0]!.attributes['gen_ai.conversation.id']).toBe('RM_test');
  });

  const setters = [
    {
      name: 'request',
      set: (span: Span) => genAI.setRequestAttributes(span, { operation: 'chat' }),
    },
    {
      name: 'tool',
      set: (span: Span) => genAI.setToolAttributes(span, { name: 'get_weather' }),
    },
    {
      name: 'agent',
      set: (span: Span) =>
        genAI.setAgentAttributes(span, { operation: 'invoke_agent', agentName: 'agent' }),
    },
    {
      name: 'workflow',
      set: (span: Span) => genAI.setWorkflowAttributes(span, { name: 'agent_session' }),
    },
  ];

  it.each(
    APIs.flatMap((api) =>
      setters.flatMap((setter) =>
        [undefined, 'RM_test'].flatMap((conversationId) =>
          [undefined, 'explicit'].map((explicitId) => ({
            api,
            setter,
            conversationId,
            explicitId,
          })),
        ),
      ),
    ),
  )(
    '$api $setter.name setter preserves conversation=$conversationId explicit=$explicitId',
    async ({ api, setter, conversationId, explicitId }) => {
      const attributes = explicitId ? { 'gen_ai.conversation.id': explicitId } : undefined;

      await inConversation(conversationId, () =>
        withSpan(api, attributes, (span) => {
          setter.set(span);
          inConversation('RM_other', () => setter.set(span));
        }),
      );

      expect(exporter.getFinishedSpans()[0]!.attributes['gen_ai.conversation.id']).toBe(
        explicitId ?? conversationId,
      );
    },
  );
});
