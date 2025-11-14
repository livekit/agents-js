// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { AccessToken } from 'livekit-server-sdk';

export interface StartSpanOptions {
  /** Name of the span */
  name: string;
  /** Optional parent context to use for this span */
  context?: Context;
  /** Attributes to set on the span when it starts */
  attributes?: Attributes;
  /** Whether to end the span when the function exits (default: true) */
  endOnExit?: boolean;
}

/**
 * A dynamic tracer that allows the tracer provider to be changed at runtime.
 */
class DynamicTracer {
  private tracerProvider: TracerProvider;
  private tracer: Tracer;
  private readonly instrumentingModuleName: string;

  constructor(instrumentingModuleName: string) {
    this.instrumentingModuleName = instrumentingModuleName;
    this.tracerProvider = trace.getTracerProvider();
    this.tracer = trace.getTracer(instrumentingModuleName);
  }

  /**
   * Set a new tracer provider. This updates the underlying tracer instance.
   * @param provider - The new tracer provider to use
   */
  setProvider(provider: TracerProvider): void {
    this.tracerProvider = provider;
    this.tracer = this.tracerProvider.getTracer(this.instrumentingModuleName);
  }

  /**
   * Get the underlying OpenTelemetry tracer.
   * Use this to access the full Tracer API when needed.
   */
  getTracer(): Tracer {
    return this.tracer;
  }

  /**
   * Start a span manually (without making it active).
   * You must call span.end() when done.
   *
   * @param options - Span configuration including name
   * @returns The created span
   */
  startSpan(options: StartSpanOptions): Span {
    const ctx = options.context || otelContext.active();
    const span = this.tracer.startSpan(
      options.name,
      {
        attributes: options.attributes,
      },
      ctx,
    );

    return span;
  }

  /**
   * Start a new span and make it active in the current context.
   * The span will automatically be ended when the provided function completes (unless endOnExit=false).
   *
   * @param fn - The function to execute within the span context
   * @param options - Span configuration including name
   * @returns The result of the provided function
   */
  async startActiveSpan<T>(fn: (span: Span) => Promise<T>, options: StartSpanOptions): Promise<T> {
    const ctx = options.context || otelContext.active();
    const endOnExit = options.endOnExit === undefined ? true : options.endOnExit; // default true
    const opts: SpanOptions = { attributes: options.attributes };

    return new Promise((resolve, reject) => {
      this.tracer.startActiveSpan(options.name, opts, ctx, async (span) => {
        try {
          const result = await fn(span);
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          if (endOnExit) {
            span.end();
          }
        }
      });
    });
  }

  /**
   * Synchronous version of startActiveSpan for non-async operations.
   *
   * @param fn - The function to execute within the span context
   * @param options - Span configuration including name
   * @returns The result of the provided function
   */
  startActiveSpanSync<T>(fn: (span: Span) => T, options: StartSpanOptions): T {
    const ctx = options.context || otelContext.active();
    const endOnExit = options.endOnExit === undefined ? true : options.endOnExit; // default true
    const opts: SpanOptions = { attributes: options.attributes };

    return this.tracer.startActiveSpan(options.name, opts, ctx, (span) => {
      try {
        return fn(span);
      } finally {
        if (endOnExit) {
          span.end();
        }
      }
    });
  }
}

/**
 * The global tracer instance used throughout the agents framework.
 * This tracer can have its provider updated at runtime via setTracerProvider().
 */
export const tracer = new DynamicTracer('livekit-agents');

class MetadataSpanProcessor implements SpanProcessor {
  private metadata: Attributes;

  constructor(metadata: Attributes) {
    this.metadata = metadata;
  }

  onStart(span: Span, _parentContext: Context): void {
    span.setAttributes(this.metadata);
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// TODO(brian): PR4 - Add MetadataLogProcessor for structured logging

// TODO(brian): PR4 - Add ExtraDetailsProcessor for structured logging

/**
 * Set the tracer provider for the livekit-agents framework.
 * This should be called before agent session start if using custom tracer providers.
 *
 * @param provider - The tracer provider to use (must be a NodeTracerProvider)
 * @param options - Optional configuration with metadata property to inject into all spans
 *
 * @example
 * ```typescript
 * import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
 * import { setTracerProvider } from '@livekit/agents/telemetry';
 *
 * const provider = new NodeTracerProvider();
 * setTracerProvider(provider, {
 *   metadata: { room_id: 'room123', job_id: 'job456' }
 * });
 * ```
 */
export function setTracerProvider(
  provider: NodeTracerProvider,
  options?: { metadata?: Attributes },
): void {
  if (options?.metadata) {
    provider.addSpanProcessor(new MetadataSpanProcessor(options.metadata));
  }

  tracer.setProvider(provider);
}

/**
 * Setup OpenTelemetry tracer for LiveKit Cloud observability.
 * This configures OTLP exporters to send traces to LiveKit Cloud.
 *
 * @param options - Configuration for cloud tracer with roomId, jobId, and cloudHostname properties
 *
 * @internal
 */
export async function setupCloudTracer(options: {
  roomId: string;
  jobId: string;
  cloudHostname: string;
}): Promise<void> {
  const { roomId, jobId, cloudHostname } = options;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set for cloud tracing');
  }

  const token = new AccessToken(apiKey, apiSecret, {
    identity: 'livekit-agents-telemetry',
    ttl: '6h',
  });
  token.addObservabilityGrant({ write: true });

  try {
    const jwt = await token.toJwt();

    const headers = {
      Authorization: `Bearer ${jwt}`,
    };

    const metadata: Attributes = {
      room_id: roomId,
      job_id: jobId,
    };

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: 'livekit-agents',
      room_id: roomId,
      job_id: jobId,
    });

    // Configure OTLP exporter to send traces to LiveKit Cloud
    const spanExporter = new OTLPTraceExporter({
      url: `https://${cloudHostname}/observability/traces/otlp/v0`,
      headers,
      compression: CompressionAlgorithm.GZIP,
    });

    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new MetadataSpanProcessor(metadata), new BatchSpanProcessor(spanExporter)],
    });
    tracerProvider.register();

    // Metadata processor is already configured in the constructor above
    setTracerProvider(tracerProvider);

    // TODO(brian): PR4 - Add logger provider setup here for structured logging
    // Similar to Python's setup: LoggerProvider, OTLPLogExporter, BatchLogRecordProcessor
  } catch (error) {
    console.error('Failed to setup cloud tracer:', error);
    throw error;
  }
}
