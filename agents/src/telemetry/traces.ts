// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { MetricsRecordingHeader } from '@livekit/protocol';
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
import { SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import FormData from 'form-data';
import { AccessToken } from 'livekit-server-sdk';
import fs from 'node:fs/promises';
import type { ChatContent, ChatItem } from '../llm/index.js';
import { enableOtelLogging } from '../log.js';
import type { SessionReport } from '../voice/report.js';
import { type SimpleLogRecord, SimpleOTLPHttpLogExporter } from './otel_http_exporter.js';
import { flushPinoLogs, initPinoCloudExporter } from './pino_otel_transport.js';

export interface StartSpanOptions {
  /** Name of the span */
  name: string;
  /** Optional parent context to use for this span */
  context?: Context;
  /** Attributes to set on the span when it starts */
  attributes?: Attributes;
  /** Whether to end the span when the function exits (default: true) */
  endOnExit?: boolean;
  /** Optional start time for the span in milliseconds (Date.now() format) */
  startTime?: number;
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
        startTime: options.startTime,
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
    const opts: SpanOptions = { attributes: options.attributes, startTime: options.startTime };

    // Directly return the tracer's startActiveSpan result - it handles async correctly
    return await this.tracer.startActiveSpan(options.name, opts, ctx, async (span) => {
      try {
        return await fn(span);
      } finally {
        if (endOnExit) {
          span.end();
        }
      }
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
    const opts: SpanOptions = { attributes: options.attributes, startTime: options.startTime };

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

    setTracerProvider(tracerProvider);

    // Initialize standalone Pino cloud exporter (no OTEL SDK dependency)
    initPinoCloudExporter({
      cloudHostname,
      roomId,
      jobId,
    });

    enableOtelLogging();
  } catch (error) {
    console.error('Failed to setup cloud tracer:', error);
    throw error;
  }
}

/**
 * Flush all pending Pino logs to ensure they are exported.
 * Call this before session/job ends to ensure all logs are sent.
 *
 * @internal
 */
export async function flushOtelLogs(): Promise<void> {
  await flushPinoLogs();
}

/**
 * Convert ChatItem to proto-compatible dictionary format.
 * TODO: Use actual agent_session proto types once @livekit/protocol v1.43.1+ is published
 */
function chatItemToProto(item: ChatItem): Record<string, any> {
  const itemDict: Record<string, any> = {};

  if (item.type === 'message') {
    const roleMap: Record<string, string> = {
      developer: 'DEVELOPER',
      system: 'SYSTEM',
      user: 'USER',
      assistant: 'ASSISTANT',
    };

    const msg: Record<string, any> = {
      id: item.id,
      role: roleMap[item.role] || item.role.toUpperCase(),
      content: item.content.map((c: ChatContent) => ({ text: c })),
      createdAt: toRFC3339(item.createdAt),
    };

    if (item.interrupted) {
      msg.interrupted = item.interrupted;
    }

    // TODO(brian): Add extra and transcriptConfidence to ChatMessage
    // if (item.extra && Object.keys(item.extra).length > 0) {
    //   msg.extra = item.extra;
    // }

    // if (item.transcriptConfidence !== undefined && item.transcriptConfidence !== null) {
    //   msg.transcriptConfidence = item.transcriptConfidence;
    // }

    // TODO(brian): Add metrics to ChatMessage
    // const metrics = item.metrics || {};
    // if (Object.keys(metrics).length > 0) {
    //   msg.metrics = {};
    //   if (metrics.started_speaking_at) {
    //     msg.metrics.startedSpeakingAt = toRFC3339(metrics.started_speaking_at);
    //   }
    //   if (metrics.stopped_speaking_at) {
    //     msg.metrics.stoppedSpeakingAt = toRFC3339(metrics.stopped_speaking_at);
    //   }
    //   if (metrics.transcription_delay !== undefined) {
    //     msg.metrics.transcriptionDelay = metrics.transcription_delay;
    //   }
    //   if (metrics.end_of_turn_delay !== undefined) {
    //     msg.metrics.endOfTurnDelay = metrics.end_of_turn_delay;
    //   }
    //   if (metrics.on_user_turn_completed_delay !== undefined) {
    //     msg.metrics.onUserTurnCompletedDelay = metrics.on_user_turn_completed_delay;
    //   }
    //   if (metrics.llm_node_ttft !== undefined) {
    //     msg.metrics.llmNodeTtft = metrics.llm_node_ttft;
    //   }
    //   if (metrics.tts_node_ttfb !== undefined) {
    //     msg.metrics.ttsNodeTtfb = metrics.tts_node_ttfb;
    //   }
    //   if (metrics.e2e_latency !== undefined) {
    //     msg.metrics.e2eLatency = metrics.e2e_latency;
    //   }
    // }

    itemDict.message = msg;
  } else if (item.type === 'function_call') {
    itemDict.functionCall = {
      id: item.id,
      callId: item.callId,
      arguments: item.args,
      name: item.name,
      createdAt: toRFC3339(item.createdAt),
    };
  } else if (item.type === 'function_call_output') {
    itemDict.functionCallOutput = {
      id: item.id,
      name: item.name,
      callId: item.callId,
      output: item.output,
      isError: item.isError,
      createdAt: toRFC3339(item.createdAt),
    };
  } else if (item.type === 'agent_handoff') {
    const handoff: Record<string, any> = {
      id: item.id,
      newAgentId: item.newAgentId,
      createdAt: toRFC3339(item.createdAt),
    };
    if (item.oldAgentId !== undefined && item.oldAgentId !== null && item.oldAgentId !== '') {
      handoff.oldAgentId = item.oldAgentId;
    }
    itemDict.agentHandoff = handoff;
  }

  try {
    if (item.type === 'function_call' && typeof itemDict.functionCall?.arguments === 'string') {
      itemDict.functionCall.arguments = JSON.parse(itemDict.functionCall.arguments);
    } else if (
      item.type === 'function_call_output' &&
      typeof itemDict.functionCallOutput?.output === 'string'
    ) {
      itemDict.functionCallOutput.output = JSON.parse(itemDict.functionCallOutput.output);
    }
  } catch {
    // ignore parsing errors
  }

  return itemDict;
}

/**
 * Convert timestamp to RFC3339 format matching Python's _to_rfc3339.
 * Note: TypeScript createdAt is in milliseconds (Date.now()), not seconds like Python.
 * @internal
 */
function toRFC3339(valueMs: number | Date): string {
  // valueMs is already in milliseconds (from Date.now())
  const dt = valueMs instanceof Date ? valueMs : new Date(valueMs);
  // Truncate sub-millisecond precision
  const truncated = new Date(Math.floor(dt.getTime()));
  return truncated.toISOString();
}

/**
 * Upload session report to LiveKit Cloud observability.
 * @param options - Configuration with agentName, cloudHostname, and report
 */
export async function uploadSessionReport(options: {
  agentName: string;
  cloudHostname: string;
  report: SessionReport;
}): Promise<void> {
  const { agentName, cloudHostname, report } = options;

  // Create OTLP HTTP exporter for chat history logs
  // Uses raw HTTP JSON format which is required by LiveKit Cloud
  const logExporter = new SimpleOTLPHttpLogExporter({
    cloudHostname,
    resourceAttributes: {
      room_id: report.roomId,
      job_id: report.jobId,
    },
    scopeName: 'chat_history',
    scopeAttributes: {
      room_id: report.roomId,
      job_id: report.jobId,
      room: report.room,
    },
  });

  // Build log records for session report and chat items
  const logRecords: SimpleLogRecord[] = [];

  const commonAttrs = {
    room_id: report.roomId,
    job_id: report.jobId,
    'logger.name': 'chat_history',
  };

  logRecords.push({
    body: 'session report',
    timestampMs: report.startedAt || report.timestamp || 0,
    attributes: {
      ...commonAttrs,
      'session.options': report.options || {},
      'session.report_timestamp': report.timestamp,
      agent_name: agentName,
    },
  });

  // Track last timestamp to ensure monotonic ordering when items have identical timestamps
  // This fixes the issue where function_call and function_call_output with same timestamp
  // get reordered by the dashboard
  let lastTimestamp = 0;
  for (const item of report.chatHistory.items) {
    // Skip null/undefined items
    if (!item) continue;

    // Ensure monotonically increasing timestamps for proper ordering
    // Add 0.001ms (1 microsecond) offset when timestamps collide
    // Also handle undefined/NaN timestamps from realtime mode (defensive)
    const hasValidTimestamp = Number.isFinite(item.createdAt);
    let itemTimestamp = hasValidTimestamp ? item.createdAt : Date.now();

    if (itemTimestamp <= lastTimestamp) {
      itemTimestamp = lastTimestamp + 0.001; // Add 1 microsecond
    }
    lastTimestamp = itemTimestamp;

    const itemProto = chatItemToProto(item);
    let severityNumber = SeverityNumber.UNSPECIFIED;
    let severityText = 'unspecified';

    if (item.type === 'function_call_output' && item.isError) {
      severityNumber = SeverityNumber.ERROR;
      severityText = 'error';
    }

    logRecords.push({
      body: 'chat item',
      timestampMs: itemTimestamp, // Adjusted for monotonic ordering
      attributes: { 'chat.item': itemProto, ...commonAttrs },
      severityNumber,
      severityText,
    });
  }

  await logExporter.export(logRecords);

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set for session upload');
  }

  const token = new AccessToken(apiKey, apiSecret, { ttl: '6h' });
  token.addObservabilityGrant({ write: true });
  const jwt = await token.toJwt();

  const formData = new FormData();

  // Add header (protobuf MetricsRecordingHeader)
  const audioStartTime = report.audioRecordingStartedAt ?? 0;
  const headerMsg = new MetricsRecordingHeader({
    roomId: report.roomId,
    duration: BigInt(0), // TODO: Calculate actual duration from report
    startTime: {
      seconds: BigInt(Math.floor(audioStartTime / 1000)),
      nanos: Math.floor((audioStartTime % 1000) * 1e6),
    },
  });

  const headerBytes = Buffer.from(headerMsg.toBinary());
  formData.append('header', headerBytes, {
    filename: 'header.binpb',
    contentType: 'application/protobuf',
    knownLength: headerBytes.length,
    header: {
      'Content-Type': 'application/protobuf',
      'Content-Length': headerBytes.length.toString(),
    },
  });

  // Add chat_history JSON
  const chatHistoryJson = JSON.stringify(report.chatHistory.toJSON({ excludeTimestamp: false }));
  const chatHistoryBuffer = Buffer.from(chatHistoryJson, 'utf-8');
  formData.append('chat_history', chatHistoryBuffer, {
    filename: 'chat_history.json',
    contentType: 'application/json',
    knownLength: chatHistoryBuffer.length,
    header: {
      'Content-Type': 'application/json',
      'Content-Length': chatHistoryBuffer.length.toString(),
    },
  });

  // Add audio recording file if available
  if (report.audioRecordingPath && report.audioRecordingStartedAt) {
    let audioBytes: Buffer;
    try {
      audioBytes = await fs.readFile(report.audioRecordingPath);
    } catch {
      audioBytes = Buffer.alloc(0);
    }

    if (audioBytes.length > 0) {
      formData.append('audio', audioBytes, {
        filename: 'recording.ogg',
        contentType: 'audio/ogg',
        knownLength: audioBytes.length,
        header: {
          'Content-Type': 'audio/ogg',
          'Content-Length': audioBytes.length.toString(),
        },
      });
    }
  }

  // Upload to LiveKit Cloud using form-data's submit method
  // This properly streams the multipart form with all headers including Content-Length
  return new Promise<void>((resolve, reject) => {
    formData.submit(
      {
        protocol: 'https:',
        host: cloudHostname,
        path: '/observability/recordings/v0',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      },
      (err, res) => {
        if (err) {
          reject(new Error(`Failed to upload session report: ${err.message}`));
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          // Read response body for error details
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('error', (readErr) => {
            reject(
              new Error(
                `Failed to upload session report: ${res.statusCode} ${res.statusMessage} (body read error: ${readErr.message})`,
              ),
            );
          });
          res.on('end', () => {
            reject(
              new Error(
                `Failed to upload session report: ${res.statusCode} ${res.statusMessage} - ${body}`,
              ),
            );
          });
          return;
        }

        res.resume(); // Drain the response
        res.on('error', (readErr) => reject(new Error(`Response read error: ${readErr.message}`)));
        res.on('end', () => resolve());
      },
    );
  });
}
