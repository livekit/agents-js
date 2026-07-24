// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, trace } from '@opentelemetry/api';
// The framework's own SDK package: the built-in cloud exporter is constructed from it, so the
// fallback assertion checks against this BatchSpanProcessor, not the aliased one.
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
// Real OpenTelemetry SDK 2.x packages, installed under aliases so they resolve independently of
// this package's own SDK dependency (which is also 2.x). Included in `pnpm typecheck`, this file
// is the compile-time regression test that the telemetry API composes with a user-supplied SDK
// 2.x provider without type errors, and the runtime regression test that spans flushed through
// such a provider actually reach both the user's exporter and the cloud span processor.
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from 'otel-v2-sdk-trace-base';
import { NodeTracerProvider } from 'otel-v2-sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CloudSpanProcessorOptions,
  FanoutSpanProcessor,
  setTracerProvider,
  setupCloudTracer,
  tracer,
} from './traces.js';

describe('setupCloudTracer with an OpenTelemetry SDK 2.x provider', () => {
  let userExporter: InMemorySpanExporter;
  let cloudExporter: InMemorySpanExporter;
  let fanout: FanoutSpanProcessor;
  let provider: NodeTracerProvider;
  let prevKey: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevKey = process.env.LIVEKIT_API_KEY;
    prevSecret = process.env.LIVEKIT_API_SECRET;
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';

    userExporter = new InMemorySpanExporter();
    cloudExporter = new InMemorySpanExporter();
    fanout = new FanoutSpanProcessor();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(userExporter), fanout],
    });
  });

  afterEach(async () => {
    await provider.shutdown();
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

  it('exports spans to both the user exporter and the cloud span processor', async () => {
    let cloudOptions: CloudSpanProcessorOptions | undefined;
    setTracerProvider(provider, {
      registerSpanProcessor: (processor) => fanout.add(processor),
      createCloudSpanProcessor: (options) => {
        cloudOptions = options;
        return new SimpleSpanProcessor(cloudExporter);
      },
    });

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    const span = tracer.startSpan({ name: 'otel2-span' });
    span.end();
    await provider.forceFlush();

    expect(tracer.getProvider()).toBe(provider);
    expect(cloudOptions?.url).toBe('https://example.livekit.cloud/observability/traces/otlp/v0');
    expect(cloudOptions?.headers.Authorization).toMatch(/^Bearer /);

    const cloudSpans = cloudExporter.getFinishedSpans();
    expect(cloudSpans.map((s) => s.name)).toEqual(['otel2-span']);
    // room_id/job_id are the attributes LiveKit Cloud correlates traces on; their presence
    // proves the metadata span processor works against SDK 2.x spans at runtime.
    expect(cloudSpans[0]!.attributes).toMatchObject({ room_id: 'room1', job_id: 'job1' });

    expect(userExporter.getFinishedSpans().map((s) => s.name)).toEqual(['otel2-span']);
  });

  it('forwards the SDK 2.x onEnding hook to dynamically registered processors', async () => {
    setTracerProvider(provider, {
      registerSpanProcessor: (processor) => fanout.add(processor),
      createCloudSpanProcessor: () => new SimpleSpanProcessor(cloudExporter),
    });

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    const onEndingProcessor: SpanProcessor = {
      forceFlush: async () => undefined,
      onStart: () => undefined,
      onEnding: (span) => span.setAttribute('livekit.test.on_ending', true),
      onEnd: () => undefined,
      shutdown: async () => undefined,
    };
    fanout.add(onEndingProcessor);

    const span = tracer.startSpan({ name: 'otel2-on-ending' });
    span.end();
    await provider.forceFlush();

    // onEnding fires while the span is still mutable, before any onEnd export, so the
    // attribute it sets must be visible to both backends.
    const [cloudSpan] = cloudExporter.getFinishedSpans();
    const [userSpan] = userExporter.getFinishedSpans();
    expect(cloudSpan!.attributes['livekit.test.on_ending']).toBe(true);
    expect(userSpan!.attributes['livekit.test.on_ending']).toBe(true);
  });

  it('falls back to the built-in cloud exporter when no processor factory is supplied', async () => {
    // The built-in cloud exporter is SDK 2.x, matching the provider, so a factory is optional.
    // The registrar records instead of attaching so the test never flushes over the network.
    const registered: unknown[] = [];
    setTracerProvider(provider, {
      registerSpanProcessor: (processor) => registered.push(processor),
    });

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    expect(tracer.getProvider()).toBe(provider);
    // session metadata processor + built-in cloud span processor
    expect(registered).toHaveLength(2);
    expect(registered[1]).toBeInstanceOf(BatchSpanProcessor);
  });
});
