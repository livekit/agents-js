// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type Attributes,
  type Context,
  DiagConsoleLogger,
  DiagLogLevel,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
  diag,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import { SeverityNumber, logs } from '@opentelemetry/api-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import NodeFormData from 'form-data';
import { AccessToken } from 'livekit-server-sdk';
import { initializeLogger, log } from '../log.js';
import type { SessionReport } from '../voice/report.js';
import { sessionReportToJSON } from '../voice/report.js';

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

  // Enable OTEL diagnostic logging FIRST (before creating any exporters)
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.VERBOSE);
  console.log('🔍 OTEL diagnostic logging enabled at VERBOSE level (will show HTTP details)');

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
    const traceUrl = `https://${cloudHostname}/observability/traces/otlp/v0`;
    console.log(`📤 Creating OTLP trace exporter for: ${traceUrl}`);
    console.log(`📤 Auth header: ${headers.Authorization.substring(0, 20)}...`);

    // Test HTTP endpoint manually first
    try {
      console.log(`🔍 Testing trace endpoint with fetch...`);
      const testResponse = await fetch(traceUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ test: 'ping' }),
      });
      console.log(`🔍 Test response: ${testResponse.status} ${testResponse.statusText}`);
    } catch (testError) {
      console.error(`❌ Test fetch failed:`, testError);
    }

    const baseExporter = new OTLPTraceExporter({
      url: traceUrl,
      headers,
      // Try without compression first to debug
      // compression: CompressionAlgorithm.GZIP,
    });

    // Wrap exporter to log export calls with detailed result
    const spanExporter = {
      export: (spans: ReadableSpan[], resultCallback: (result: any) => void) => {
        console.log(`🚀 Exporter.export() called with ${spans.length} spans`);
        console.log(`   Span names: ${spans.map((s) => s.name).join(', ')}`);

        const startTime = Date.now();
        baseExporter.export(spans, (result) => {
          const duration = Date.now() - startTime;
          console.log(`📬 Export completed in ${duration}ms`);
          console.log(`   Result code: ${result.code}`);
          if (result.error) {
            console.error(`   ❌ Export error:`, result.error);
          } else {
            console.log(`   ✅ Export successful`);
          }
          resultCallback(result);
        });
      },
      shutdown: () => baseExporter.shutdown(),
    } as any;

    console.log(`✅ OTLP trace exporter created (wrapped with logging)`);

    const tracerProvider = new NodeTracerProvider({
      resource,
      // Use SimpleSpanProcessor for immediate export during debugging/testing
      spanProcessors: [new MetadataSpanProcessor(metadata), new SimpleSpanProcessor(spanExporter)],
    });
    tracerProvider.register();

    console.log(`✅ TracerProvider registered globally`);

    // Metadata processor is already configured in the constructor above
    setTracerProvider(tracerProvider);

    // Configure Pino to send logs directly to LiveKit Cloud via pino-opentelemetry-transport
    // This is the working solution for Node.js (parity with Python behavior, different implementation)
    const logsEndpoint = `https://${cloudHostname}/observability/logs/otlp/v0`;

    initializeLogger({
      pretty: false,
      otlpLogsEndpoint: logsEndpoint,
      otlpHeaders: headers,
      otlpResourceAttributes: metadata as Record<string, string>,
    });

    console.log('✅ Cloud tracer and logger configured');
  } catch (error) {
    console.error('Failed to setup cloud tracer:', error);
    throw error;
  }
}

/**
 * Upload session report to LiveKit Cloud.
 * Ref: Python telemetry/traces.py lines 283-398 (_upload_session_report)
 *
 * Does TWO things (matching Python):
 * 1. Logs chat history to OTEL (lines 291-344)
 * 2. Uploads multipart form to Cloud (lines 347-398)
 *
 * @param options - Upload configuration
 */
export async function uploadSessionReport(options: {
  roomId: string;
  jobId: string;
  cloudHostname: string;
  report: SessionReport;
  apiKey?: string;
  apiSecret?: string;
}): Promise<void> {
  const { roomId, jobId, cloudHostname, report } = options;
  const logger = log();

  // Ref: Python lines 291-298 - Create chat_history logger and log chat items
  // Note: We use the global logger provider to get a logger
  const chatLogger = logs.getLoggerProvider().getLogger('chat_history');

  // Ref: Python lines 320-327 - Log session report metadata
  chatLogger.emit({
    body: 'session report',
    timestamp: report.timestamp * 1e6, // Convert to nanoseconds
    severityNumber: SeverityNumber.UNSPECIFIED,
    severityText: 'unspecified',
    attributes: {
      room_id: report.roomId,
      job_id: report.jobId,
      room: report.room,
      'session.options': JSON.stringify(report.options),
      'session.report_timestamp': report.timestamp,
    },
  } as any);

  // Ref: Python lines 329-344 - Log each chat item
  for (const item of report.chatHistory.items) {
    const itemLog = item.toJSON(false); // exclude_timestamp=false
    let severityNumber = SeverityNumber.UNSPECIFIED;
    let severityText = 'unspecified';

    // Set ERROR severity for failed function calls
    if (item.type === 'function_call_output' && (item as any).isError) {
      severityNumber = SeverityNumber.ERROR;
      severityText = 'error';
    }

    chatLogger.emit({
      body: 'chat item',
      timestamp: (item.createdAt || Date.now()) * 1e6, // Convert to nanoseconds
      severityNumber,
      severityText,
      attributes: {
        'chat.item': itemLog,
      },
    } as any);
  }

  const apiKey = options.apiKey || process.env.LIVEKIT_API_KEY;
  const apiSecret = options.apiSecret || process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set for session report upload');
  }

  // Ref: Python lines 347-352 - Create access token with observability grants
  const token = new AccessToken(apiKey, apiSecret, {
    identity: 'livekit-agents-session-report',
    ttl: '6h',
  });
  token.addObservabilityGrant({ write: true });
  const jwt = await token.toJwt();

  // Ref: Python lines 354-359 - Create protobuf header
  // TODO(brian): PR6 - Use protobuf MetricsRecordingHeader instead of JSON when proto support added
  const header = {
    room_id: roomId,
    // TODO(brian): PR6 - Add duration and start_time when audio recording is implemented
    duration: 0,
    start_time: 0,
  };

  // Ref: Python lines 361-366 - Create multipart form
  const form = new NodeFormData();

  // Header part (using JSON instead of protobuf for TypeScript)
  form.append('header', JSON.stringify(header), {
    filename: 'header.json',
    contentType: 'application/json',
  });

  // Ref: Python lines 368-372 - Chat history part
  const chatHistoryJson = JSON.stringify(sessionReportToJSON(report));
  form.append('chat_history', chatHistoryJson, {
    filename: 'chat_history.json',
    contentType: 'application/json',
  });

  // TODO(brian): PR6 - Add audio recording part when RecorderIO is implemented
  // Ref: Python lines 374-386 - Audio recording part (if available)
  // if (report.audioRecordingPath && report.audioRecordingStartedAt) {
  //   const audioBytes = await readFile(report.audioRecordingPath);
  //   form.append('audio', audioBytes, {
  //     filename: 'recording.ogg',
  //     contentType: 'audio/ogg',
  //   });
  // }

  // Ref: Python lines 388-396 - Upload to LiveKit Cloud
  const url = `https://${cloudHostname}/observability/recordings/v0`;
  const headers = {
    Authorization: `Bearer ${jwt}`,
    ...form.getHeaders(),
  };

  logger.debug('uploading session report to LiveKit Cloud');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers as any,
      body: form as any,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    logger.debug('finished uploading session report');
  } catch (error) {
    logger.error(
      {
        err: error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'failed to upload session report',
    );
    throw error;
  }
}
