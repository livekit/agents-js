// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { MetricsRecordingHeader } from '@livekit/protocol';
import { ProxyTracerProvider, context as otelContext, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import FormData from 'form-data';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { version } from '../version.js';
import type { SessionReport } from '../voice/report.js';
import { SimpleOTLPHttpLogExporter } from './otel_http_exporter.js';
import {
  type CloudSpanProcessorOptions,
  setTracerProvider,
  setupCloudTracer,
  tracer,
  uploadSessionReport,
} from './traces.js';

describe('setupCloudTracer default provider resource', () => {
  let provider: NodeTracerProvider | undefined;
  let prevKey: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevKey = process.env.LIVEKIT_API_KEY;
    prevSecret = process.env.LIVEKIT_API_SECRET;
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';
  });

  afterEach(async () => {
    await provider?.shutdown();
    vi.restoreAllMocks();
    otelContext.disable();
    trace.disable();
    if (prevKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevSecret;
  });

  it('preserves default SDK attributes alongside LiveKit resource metadata', async () => {
    const exportedSpans: Parameters<OTLPTraceExporter['export']>[0] = [];
    vi.spyOn(OTLPTraceExporter.prototype, 'export').mockImplementation((spans, callback) => {
      exportedSpans.push(...spans);
      callback({ code: 0 });
    });

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableLogs: false,
    });

    provider = tracer.getProvider() as NodeTracerProvider;
    const span = tracer.startSpan({ name: 'resource-test' });
    span.end();
    await provider.forceFlush();

    expect(exportedSpans).toHaveLength(1);
    expect(exportedSpans[0]!.resource.attributes).toMatchObject({
      'telemetry.sdk.language': 'nodejs',
      'telemetry.sdk.name': expect.any(String),
      'telemetry.sdk.version': expect.any(String),
      'service.name': 'livekit-agents',
      room_id: 'room1',
      job_id: 'job1',
    });
  });
});

/** Helper: extract a parent span ID from an OTel SDK 2.x readable span. */
function parentSpanId(span: unknown): string | undefined {
  return (span as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId;
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
    const registeredProcessors: SpanProcessor[] = [];
    setTracerProvider(userProvider, {
      registerSpanProcessor: (processor) => registeredProcessors.push(processor),
      metadata: { 'lk.redaction.enabled': true },
    });

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      agentName: 'my-agent',
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
    // agent_name rides the session metadata so spans (and logs) carry it even on
    // the custom-provider path, where the resource is left untouched.
    expect(setAttributes).toHaveBeenCalledWith({
      room_id: 'room1',
      job_id: 'job1',
      'lk.agent_name': 'my-agent',
    });
    expect(registeredProcessors[2]).toBeInstanceOf(BatchSpanProcessor);
  });

  it('passes the gated exporter to a user-supplied cloud processor factory', async () => {
    const registeredProcessors: SpanProcessor[] = [];
    let factoryProcessor: SimpleSpanProcessor | undefined;
    const createCloudSpanProcessor = vi.fn((options: CloudSpanProcessorOptions) => {
      factoryProcessor = new SimpleSpanProcessor(options.exporter);
      return factoryProcessor;
    });
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

  it('requires registerSpanProcessor and never calls addSpanProcessor', async () => {
    const addSpanProcessor = vi.fn();
    Object.defineProperty(userProvider, 'addSpanProcessor', { value: addSpanProcessor });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setTracerProvider(userProvider, { metadata: { custom: true } });

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    expect(tracer.getProvider()).toBe(userProvider);
    expect(addSpanProcessor).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registerSpanProcessor'));
  });

  it('warns when a cloud processor factory is supplied without a usable registrar', () => {
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

function makeReport(recordingOptions: SessionReport['options']['recordingOptions']): SessionReport {
  return {
    jobId: 'job1',
    roomId: 'room1',
    room: 'room-name',
    options: { recordingOptions },
    events: [],
    chatHistory: ChatContext.empty(),
    enableRecording: true,
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

  it('includes the SDK version, simulation, and redaction metadata on exported session-report logs', async () => {
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
      sdk_version: version,
      'lk.simulation.enabled': true,
      'lk.redaction.enabled': true,
    });
    expect(records[0]?.attributes).not.toHaveProperty('session.simulation');
  });

  it('marks session keyterms as PII in exported session-report logs', async () => {
    const exportSpy = vi
      .spyOn(SimpleOTLPHttpLogExporter.prototype, 'export')
      .mockResolvedValue(undefined);
    const keytermsOptions = {
      keyterms: ['Acme Corp'],
      keytermDetection: { enabled: false },
    };
    const report = makeReport({
      audio: false,
      traces: true,
      logs: false,
      transcript: false,
      redaction: false,
    });
    report.options = { ...report.options, keytermsOptions };

    await uploadSessionReport({
      agentName: 'agent',
      cloudHostname: 'example.livekit.cloud',
      report,
    });

    const records = exportSpy.mock.calls[0]?.[0] ?? [];
    const serializedOptions = records[0]?.attributes['session.options'] as Record<string, unknown>;
    const serializedKeytermsOptions = serializedOptions.keytermsOptions as Record<string, unknown>;
    expect(serializedKeytermsOptions['lk.pii.keyterms']).toEqual(['Acme Corp']);
    expect(serializedKeytermsOptions).not.toHaveProperty('keyterms');
    expect(serializedKeytermsOptions.keytermDetection).toEqual({ enabled: false });
    expect(keytermsOptions.keyterms).toEqual(['Acme Corp']);
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

describe('setupCloudTracer resource identity (fresh provider)', () => {
  let prevKey: string | undefined;
  let prevSecret: string | undefined;
  let prevOtelAttrs: string | undefined;
  let prevAgentId: string | undefined;
  let prevDeployment: string | undefined;

  // OTel 2.x providers no longer expose their resource; read it off a probe
  // span (started but never ended, so nothing is enqueued for export).
  const providerResourceAttrs = () => {
    const provider = tracer.getProvider();
    expect(provider).toBeInstanceOf(NodeTracerProvider);
    const span = provider.getTracer('resource-probe').startSpan('probe');
    return (span as unknown as ReadableSpan).resource.attributes;
  };

  beforeEach(() => {
    prevKey = process.env.LIVEKIT_API_KEY;
    prevSecret = process.env.LIVEKIT_API_SECRET;
    prevOtelAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
    prevAgentId = process.env.LIVEKIT_AGENT_ID;
    prevDeployment = process.env.LIVEKIT_AGENT_DEPLOYMENT;
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';
    // Start with no identity env vars so each test controls them explicitly.
    delete process.env.LIVEKIT_AGENT_ID;
    delete process.env.LIVEKIT_AGENT_DEPLOYMENT;
    // no user-configured provider: reset the module tracer to the API proxy so
    // setupCloudTracer takes the fresh-provider path
    setTracerProvider(new ProxyTracerProvider());
  });

  afterEach(async () => {
    const provider = tracer.getProvider();
    // No span is created/ended in these tests, so shutting down the cloud
    // BatchSpanProcessor has nothing to flush over the network.
    if (provider instanceof NodeTracerProvider) {
      await provider.shutdown();
    }
    otelContext.disable();
    trace.disable();
    if (prevKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevSecret;
    if (prevOtelAttrs === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = prevOtelAttrs;
    if (prevAgentId === undefined) delete process.env.LIVEKIT_AGENT_ID;
    else process.env.LIVEKIT_AGENT_ID = prevAgentId;
    if (prevDeployment === undefined) delete process.env.LIVEKIT_AGENT_DEPLOYMENT;
    else process.env.LIVEKIT_AGENT_DEPLOYMENT = prevDeployment;
  });

  it('stamps lk.agent_name and merges OTEL_RESOURCE_ATTRIBUTES, explicit attrs winning', async () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      'lk.cloud_agent_id=CA_test,lk.agent_name=env-name,lk.deployment_id=v42';

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      agentName: 'sdk-name',
      enableTraces: true,
      enableLogs: false,
    });

    const attrs = providerResourceAttrs();
    expect(attrs['lk.cloud_agent_id']).toBe('CA_test');
    expect(attrs['lk.deployment_id']).toBe('v42');
    expect(attrs['lk.agent_name']).toBe('sdk-name'); // explicit beats env on collision
    expect(attrs['room_id']).toBe('room1');
    expect(attrs['job_id']).toBe('job1');
  });

  it('omits lk.agent_name for default dispatch (empty name)', async () => {
    await setupCloudTracer({
      roomId: 'room2',
      jobId: 'job2',
      cloudHostname: 'example.livekit.cloud',
      agentName: '',
      enableTraces: true,
      enableLogs: false,
    });

    const attrs = providerResourceAttrs();
    expect(attrs['lk.agent_name']).toBeUndefined();
    expect(attrs['room_id']).toBe('room2');
  });

  it('stamps lk.cloud_agent_id / lk.deployment_id from the LiveKit Cloud env vars', async () => {
    process.env.LIVEKIT_AGENT_ID = 'CA_test';
    process.env.LIVEKIT_AGENT_DEPLOYMENT = 'canary';

    await setupCloudTracer({
      roomId: 'room3',
      jobId: 'job3',
      cloudHostname: 'example.livekit.cloud',
      agentName: '',
      enableTraces: true,
      enableLogs: false,
    });

    const attrs = providerResourceAttrs();
    expect(attrs['lk.cloud_agent_id']).toBe('CA_test');
    expect(attrs['lk.deployment_id']).toBe('canary');
  });

  it('LIVEKIT_AGENT_ID wins over a matching OTEL_RESOURCE_ATTRIBUTES key', async () => {
    process.env.LIVEKIT_AGENT_ID = 'CA_env';
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'lk.cloud_agent_id=CA_other,custom.attr=keep';

    await setupCloudTracer({
      roomId: 'room4',
      jobId: 'job4',
      cloudHostname: 'example.livekit.cloud',
      agentName: '',
      enableTraces: true,
      enableLogs: false,
    });

    const attrs = providerResourceAttrs();
    expect(attrs['lk.cloud_agent_id']).toBe('CA_env'); // env-provided value wins
    expect(attrs['custom.attr']).toBe('keep'); // other attributes preserved
  });

  it('omits identity attrs when the env vars are unset', async () => {
    await setupCloudTracer({
      roomId: 'room5',
      jobId: 'job5',
      cloudHostname: 'example.livekit.cloud',
      agentName: '',
      enableTraces: true,
      enableLogs: false,
    });

    const attrs = providerResourceAttrs();
    expect(attrs['lk.cloud_agent_id']).toBeUndefined();
    expect(attrs['lk.deployment_id']).toBeUndefined();
  });

  it('omits lk.deployment_id for the production deployment (empty value)', async () => {
    process.env.LIVEKIT_AGENT_ID = 'CA_test';
    process.env.LIVEKIT_AGENT_DEPLOYMENT = '';

    await setupCloudTracer({
      roomId: 'room6',
      jobId: 'job6',
      cloudHostname: 'example.livekit.cloud',
      agentName: '',
      enableTraces: true,
      enableLogs: false,
    });

    const attrs = providerResourceAttrs();
    expect(attrs['lk.cloud_agent_id']).toBe('CA_test');
    expect(attrs['lk.deployment_id']).toBeUndefined();
  });
});
