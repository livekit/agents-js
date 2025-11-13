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

export interface SpanStartOptions {
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
  startSpan(options: SpanStartOptions): Span {
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
  async startActiveSpan<T>(fn: (span: Span) => Promise<T>, options: SpanStartOptions): Promise<T> {
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
  startActiveSpanSync<T>(fn: (span: Span) => T, options: SpanStartOptions): T {
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

/**
 * Set the tracer provider for the livekit-agents framework.
 * This should be called before agent session start if using custom tracer providers.
 *
 * @param provider - The tracer provider to use
 *
 * @example
 * ```typescript
 * import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
 * import { setTracerProvider } from '@livekit/agents/telemetry';
 *
 * const provider = new NodeTracerProvider();
 * setTracerProvider(provider);
 * ```
 */
export function setTracerProvider(provider: TracerProvider): void {
  tracer.setProvider(provider);
}
