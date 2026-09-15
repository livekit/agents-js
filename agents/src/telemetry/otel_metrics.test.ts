// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { metrics, context as otelContext, trace } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { MeterProvider, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordEventLoopBlocked } from './otel_metrics.js';
import { setupCloudTracer, tracer } from './traces.js';

describe('cloud metrics pipeline', () => {
  let prevKey: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevKey = process.env.LIVEKIT_API_KEY;
    prevSecret = process.env.LIVEKIT_API_SECRET;
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecretsecret';
    vi.spyOn(OTLPTraceExporter.prototype, 'export').mockImplementation((_spans, callback) =>
      callback({ code: 0 }),
    );
  });

  afterEach(async () => {
    const provider = tracer.getProvider();
    if (provider instanceof NodeTracerProvider) await provider.shutdown();
    await (metrics.getMeterProvider() as Partial<MeterProvider>).shutdown?.();
    metrics.disable();
    otelContext.disable();
    trace.disable();
    vi.restoreAllMocks();
    if (prevKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevKey;
    if (prevSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevSecret;
  });

  it('installs a meter provider on a fresh process and exports the blocked-loop histogram', async () => {
    // a fresh process: the API hands out its no-op provider and nothing is registered globally
    expect(metrics.getMeterProvider()).not.toBeInstanceOf(MeterProvider);
    const exported: ResourceMetrics[] = [];
    vi.spyOn(OTLPMetricExporter.prototype, 'export').mockImplementation((items, callback) => {
      exported.push(items);
      callback({ code: 0 });
    });

    await setupCloudTracer({
      roomId: 'room1',
      jobId: 'job1',
      observabilityUrl: 'https://example.livekit.cloud',
      enableLogs: false,
    });

    const provider = metrics.getMeterProvider();
    expect(provider).toBeInstanceOf(MeterProvider);
    recordEventLoopBlocked(0.25, 'error');
    await (provider as MeterProvider).forceFlush();

    const points = exported
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .filter((m) => m.descriptor.name === 'lk.agents.event_loop.blocked_duration')
      .flatMap((m) => m.dataPoints);
    expect(points).toHaveLength(1);
    expect(points[0]!.attributes).toMatchObject({ severity: 'error' });
    expect((points[0]!.value as { sum?: number }).sum).toBeCloseTo(0.25);
  });
});
