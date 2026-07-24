// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { MetricsRecordingHeader } from '@livekit/protocol';
import { context as otelContext, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import FormData from 'form-data';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import type { SessionReport } from '../voice/report.js';
import { SimpleOTLPHttpLogExporter } from './otel_http_exporter.js';
import {
  type SpanProcessorLike,
  setTracerProvider,
  setupCloudTracer,
  tracer,
  uploadSessionReport,
} from './traces.js';

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
    const registeredProcessors: SpanProcessorLike[] = [];
    setTracerProvider(userProvider, {
      registerSpanProcessor: (processor) => registeredProcessors.push(processor),
      metadata: { 'lk.redaction.enabled': true },
    });

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
    // setTracerProvider registers the user metadata processor; setupCloudTracer registers the
    // session metadata processor plus the built-in (SDK 2.x) cloud exporter.
    expect(registeredProcessors).toHaveLength(3);
    const setAttributes = vi.fn();
    registeredProcessors[1]!.onStart({ setAttributes } as never, otelContext.active());
    expect(setAttributes).toHaveBeenCalledWith({
      room_id: 'room1',
      job_id: 'job1',
    });
    expect(registeredProcessors[2]).toBeInstanceOf(BatchSpanProcessor);
  });

  it('prefers a user-supplied cloud processor factory over the built-in exporter', async () => {
    const registeredProcessors: SpanProcessorLike[] = [];
    const factoryProcessor = new SimpleSpanProcessor(new InMemorySpanExporter());
    const createCloudSpanProcessor = vi.fn(() => factoryProcessor);
    setTracerProvider(userProvider, {
      registerSpanProcessor: (processor) => registeredProcessors.push(processor),
      createCloudSpanProcessor,
    });

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    expect(createCloudSpanProcessor).toHaveBeenCalledOnce();
    expect(registeredProcessors).toHaveLength(2);
    expect(registeredProcessors[1]).toBe(factoryProcessor);
  });

  it('attaches processors to an SDK 1.x provider via addSpanProcessor when a factory is supplied', async () => {
    // Simulates an OTel 1.x-style provider: addSpanProcessor is present, so the registrar
    // resolves from it, but the built-in SDK 2.x cloud exporter must not be attached — the
    // user-supplied factory builds the cloud processor from their own SDK 1.x packages.
    const addSpanProcessor = vi.fn();
    Object.defineProperty(userProvider, 'addSpanProcessor', { value: addSpanProcessor });
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

  it('warns and skips cloud tracing on an SDK 1.x provider without a processor factory', async () => {
    // An SDK 1.x provider can register processors, but this package's own SDK 2.x exporter
    // must not run inside it, so cloud tracing requires createCloudSpanProcessor.
    const addSpanProcessor = vi.fn();
    Object.defineProperty(userProvider, 'addSpanProcessor', { value: addSpanProcessor });
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
    expect(addSpanProcessor).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('createCloudSpanProcessor'));
  });

  it('warns when a cloud processor factory is supplied without a usable registrar', () => {
    // An SDK 2.x provider has no addSpanProcessor, so no registrar resolves implicitly.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    setTracerProvider(userProvider, {
      createCloudSpanProcessor: () => new SimpleSpanProcessor(new InMemorySpanExporter()),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring createCloudSpanProcessor'));
  });

  it('preserves a custom provider when no processor registrar is available', async () => {
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

function makeReport(recordingOptions: SessionReport['recordingOptions']): SessionReport {
  return {
    jobId: 'job1',
    roomId: 'room1',
    room: 'room-name',
    options: {},
    events: [],
    chatHistory: ChatContext.empty(),
    enableRecording: true,
    recordingOptions,
    startedAt: 1_700_000_000_000,
    timestamp: 1_700_000_001_000,
  };
}

function mockSuccessfulFormSubmit() {
  return vi.spyOn(FormData.prototype, 'submit').mockImplementation(function submit(_opts, cb) {
    const res = new PassThrough() as PassThrough & {
      statusCode: number;
      statusMessage: string;
      resume: () => PassThrough;
    };
    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.resume = () => {
      process.nextTick(() => res.emit('end'));
      return res;
    };
    cb?.(null, res as never);
    return {} as never;
  });
}

function getMultipartBuffer(formData: FormData, name: string): Buffer {
  const streams = (formData as unknown as { _streams: unknown[] })._streams;
  const index = streams.findIndex(
    (stream) => typeof stream === 'string' && stream.includes(`name="${name}"`),
  );
  const value = streams[index + 1];
  if (!Buffer.isBuffer(value)) {
    throw new Error(`multipart part ${name} was not a Buffer`);
  }
  return value;
}

describe('uploadSessionReport metadata', () => {
  let prevKey: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevKey = process.env.LIVEKIT_API_KEY;
    prevSecret = process.env.LIVEKIT_API_SECRET;
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevSecret;
  });

  it('includes simulation and redaction metadata on exported session-report logs', async () => {
    const exportSpy = vi
      .spyOn(SimpleOTLPHttpLogExporter.prototype, 'export')
      .mockResolvedValue(undefined);

    await uploadSessionReport({
      agentName: 'agent',
      cloudHostname: 'example.livekit.cloud',
      report: makeReport({
        audio: false,
        traces: true,
        logs: false,
        transcript: false,
        redaction: false,
      }),
      metadata: {
        'lk.simulation.enabled': true,
        'lk.redaction.enabled': true,
      },
    });

    const records = exportSpy.mock.calls[0]?.[0] ?? [];
    expect(records[0]?.attributes).toMatchObject({
      'lk.simulation.enabled': true,
      'lk.redaction.enabled': true,
    });
    expect(records[0]?.attributes).not.toHaveProperty('session.simulation');
  });

  it('sets job, simulation, and redaction fields on the multipart recording header', async () => {
    vi.spyOn(SimpleOTLPHttpLogExporter.prototype, 'export').mockResolvedValue(undefined);
    const submitSpy = mockSuccessfulFormSubmit();

    await uploadSessionReport({
      agentName: 'agent',
      cloudHostname: 'example.livekit.cloud',
      report: makeReport({
        audio: false,
        traces: false,
        logs: false,
        transcript: true,
        redaction: true,
      }),
      metadata: {
        'lk.simulation.enabled': true,
        'lk.redaction.enabled': true,
      },
    });

    const formData = submitSpy.mock.instances[0] as FormData;
    const header = MetricsRecordingHeader.fromBinary(getMultipartBuffer(formData, 'header'));
    expect(header.jobId).toBe('job1');
    expect(header.simulated).toBe(true);
    expect(header.redactionEnabled).toBe(true);
  });

  it('returns before exporting when only redaction is enabled', async () => {
    const exportSpy = vi
      .spyOn(SimpleOTLPHttpLogExporter.prototype, 'export')
      .mockResolvedValue(undefined);
    const submitSpy = mockSuccessfulFormSubmit();

    await uploadSessionReport({
      agentName: 'agent',
      cloudHostname: 'example.livekit.cloud',
      report: makeReport({
        audio: false,
        traces: false,
        logs: false,
        transcript: false,
        redaction: true,
      }),
      metadata: { 'lk.redaction.enabled': true },
    });

    expect(exportSpy).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
