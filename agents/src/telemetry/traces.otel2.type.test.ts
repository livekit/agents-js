// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, trace } from '@opentelemetry/api';
// Real OpenTelemetry SDK 2.x packages, installed under aliases so they can coexist with this
// package's SDK 1.x dependency. Included in `pnpm typecheck`, this file is the compile-time
// regression test that the telemetry API composes with an SDK 2.x provider without type errors,
// and the runtime regression test that spans flushed through such a provider actually reach both
// the user's exporter and the cloud span processor.
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from 'otel-v2-sdk-trace-base';
import { NodeTracerProvider } from 'otel-v2-sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CloudSpanProcessorOptions,
  setTracerProvider,
  setupCloudTracer,
  tracer,
} from './traces.js';

/** Span processor that forwards to a list of processors that can grow after construction. */
class FanoutSpanProcessor implements SpanProcessor {
  private readonly processors: SpanProcessor[] = [];

  add(processor: SpanProcessor): void {
    this.processors.push(processor);
  }

  onStart(...args: Parameters<SpanProcessor['onStart']>): void {
    for (const processor of this.processors) {
      processor.onStart(...args);
    }
  }

  onEnd(...args: Parameters<SpanProcessor['onEnd']>): void {
    for (const processor of this.processors) {
      processor.onEnd(...args);
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.processors.map((processor) => processor.forceFlush()));
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.processors.map((processor) => processor.shutdown()));
  }
}

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

  it('disables cloud tracing but keeps the user pipeline when no processor factory is supplied', async () => {
    setTracerProvider(provider, {
      registerSpanProcessor: (processor) => fanout.add(processor),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      cloudHostname: 'example.livekit.cloud',
      enableTraces: true,
      enableLogs: false,
    });

    const span = tracer.startSpan({ name: 'otel2-user-only' });
    span.end();
    await provider.forceFlush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('createCloudSpanProcessor'));
    expect(cloudExporter.getFinishedSpans()).toHaveLength(0);
    expect(userExporter.getFinishedSpans().map((s) => s.name)).toEqual(['otel2-user-only']);
  });
});
