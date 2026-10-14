// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTracerProvider, tracer } from './traces.js';

/** Helper: extract parentSpanId across OTel SDK v1/v2 */
function parentSpanId(span: unknown): string | undefined {
  return (
    (span as { parentSpanId?: string }).parentSpanId ??
    (span as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId
  );
}

describe('DynamicTracer', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    setTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    otelContext.disable();
    trace.disable();
  });

  it('inherits the active OTel context as parent when no explicit context is passed', async () => {
    const outerTracer = provider.getTracer('test');

    await outerTracer.startActiveSpan('outer', async (outer) => {
      const child = tracer.startSpan({ name: 'child' });
      child.end();
      outer.end();
    });

    const spans = exporter.getFinishedSpans();
    const outerSpan = spans.find((s) => s.name === 'outer');
    const childSpan = spans.find((s) => s.name === 'child');

    expect(outerSpan).toBeDefined();
    expect(childSpan).toBeDefined();
    expect(parentSpanId(childSpan)).toBe(outerSpan!.spanContext().spanId);
  });
});

describe('register() set-once semantics', () => {
  let userExporter: InMemorySpanExporter;
  let userProvider: NodeTracerProvider;
  let cloudExporter: InMemorySpanExporter;
  let cloudProvider: NodeTracerProvider;

  beforeEach(() => {
    // Step 1: User registers their own provider (simulates NodeSDK.start())
    userExporter = new InMemorySpanExporter();
    userProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(userExporter)],
    });
    userProvider.register();

    // Step 2: LiveKit cloud calls register() + setTracerProvider() (simulates setupCloudTracer)
    cloudExporter = new InMemorySpanExporter();
    cloudProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(cloudExporter)],
    });
    cloudProvider.register(); // should be a no-op since user already registered
    setTracerProvider(cloudProvider); // sets LiveKit's internal DynamicTracer
  });

  afterEach(async () => {
    await userProvider.shutdown();
    await cloudProvider.shutdown();
    otelContext.disable();
    trace.disable();
  });

  it('second register() does not replace the global context manager', () => {
    // Create a span via the global provider and verify context propagation still works
    const globalTracer = trace.getTracer('test-global');
    let contextWorks = false;

    globalTracer.startActiveSpan('test', (span) => {
      const active = trace.getSpan(otelContext.active());
      contextWorks = active === span;
      span.end();
    });

    expect(contextWorks).toBe(true);
  });

  it('spans from global tracer land in user exporter, not cloud exporter', () => {
    const globalTracer = trace.getTracer('test-global');
    globalTracer.startActiveSpan('global-span', (span) => {
      span.end();
    });

    expect(userExporter.getFinishedSpans().map((s) => s.name)).toContain('global-span');
    expect(cloudExporter.getFinishedSpans().map((s) => s.name)).not.toContain('global-span');
  });

  it('LiveKit DynamicTracer spans land in cloud exporter', () => {
    const lkSpan = tracer.startSpan({ name: 'agent_session' });
    lkSpan.end();

    expect(cloudExporter.getFinishedSpans().map((s) => s.name)).toContain('agent_session');
  });

  it('LiveKit span inherits user parent context across providers', () => {
    const userTracer = userProvider.getTracer('user-app');

    userTracer.startActiveSpan('user-parent', (parent) => {
      // LiveKit creates a child span via its DynamicTracer
      const lkSpan = tracer.startSpan({ name: 'agent_session' });
      lkSpan.end();
      parent.end();
    });

    const userSpans = userExporter.getFinishedSpans();
    const cloudSpans = cloudExporter.getFinishedSpans();

    const userParent = userSpans.find((s) => s.name === 'user-parent')!;
    const lkSession = cloudSpans.find((s) => s.name === 'agent_session')!;

    expect(userParent).toBeDefined();
    expect(lkSession).toBeDefined();

    // Same trace ID — they're part of the same distributed trace
    expect(lkSession.spanContext().traceId).toBe(userParent.spanContext().traceId);

    // LK span is a child of the user's parent span
    expect(parentSpanId(lkSession)).toBe(userParent.spanContext().spanId);
  });
});
