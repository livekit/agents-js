// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SpanProcessorLike, setTracerProvider, setupCloudTracer, tracer } from './traces.js';

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

describe('setupCloudTracer with a user-configured provider', () => {
  let userExporter: InMemorySpanExporter;
  let userProvider: NodeTracerProvider;
  let prevKey: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevKey = process.env.LIVEKIT_API_KEY;
    prevSecret = process.env.LIVEKIT_API_SECRET;
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';

    userExporter = new InMemorySpanExporter();
    userProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(userExporter)],
    });
    userProvider.register();
    setTracerProvider(userProvider);
  });

  afterEach(async () => {
    await userProvider.shutdown();
    vi.restoreAllMocks();
    otelContext.disable();
    trace.disable();
    // Assigning undefined to process.env.X stores the string "undefined"; delete instead so
    // env vars that were originally unset stay unset for later tests.
    if (prevKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevSecret;
  });

  it('does not replace the user provider (attaches the cloud exporter to it instead)', async () => {
    const addSpanProcessor = vi.spyOn(userProvider, 'addSpanProcessor');
    setTracerProvider(userProvider);

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    // No span is created/ended here so the newly attached cloud BatchSpanProcessor has
    // nothing to flush over the network on shutdown.
    expect(tracer.getProvider()).toBe(userProvider);
    expect(addSpanProcessor).toHaveBeenCalledTimes(2);
    expect(addSpanProcessor.mock.calls[1]![0]).toBeInstanceOf(BatchSpanProcessor);
  });

  it('prefers a user-supplied cloud processor factory over the built-in exporter', async () => {
    const addSpanProcessor = vi.spyOn(userProvider, 'addSpanProcessor');
    const factoryProcessor = new SimpleSpanProcessor(new InMemorySpanExporter());
    const createCloudSpanProcessor = vi.fn(() => factoryProcessor);
    setTracerProvider(userProvider, { createCloudSpanProcessor });

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    expect(createCloudSpanProcessor).toHaveBeenCalledOnce();
    expect(addSpanProcessor).toHaveBeenCalledTimes(2);
    expect(addSpanProcessor.mock.calls[1]![0]).toBe(factoryProcessor);
  });

  it('warns when a cloud processor factory is supplied without a usable registrar', () => {
    Object.defineProperty(userProvider, 'addSpanProcessor', { value: undefined });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    setTracerProvider(userProvider, {
      createCloudSpanProcessor: () => new SimpleSpanProcessor(new InMemorySpanExporter()),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring createCloudSpanProcessor'));
  });

  it('warns and skips cloud tracing when a registrar is supplied without a processor factory', async () => {
    // Simulates an OTel 2.x-style provider: no addSpanProcessor, so this package's own SDK 1.x
    // exporter must not be attached and the user has to supply createCloudSpanProcessor.
    const registeredProcessors: SpanProcessorLike[] = [];
    Object.defineProperty(userProvider, 'addSpanProcessor', { value: undefined });
    setTracerProvider(userProvider, {
      registerSpanProcessor: (processor) => registeredProcessors.push(processor),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    expect(tracer.getProvider()).toBe(userProvider);
    expect(registeredProcessors).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('createCloudSpanProcessor'));
  });

  it('preserves a custom provider when no processor registrar is available', async () => {
    Object.defineProperty(userProvider, 'addSpanProcessor', { value: undefined });
    setTracerProvider(userProvider);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    expect(tracer.getProvider()).toBe(userProvider);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registerSpanProcessor'));
  });
});
