// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { MetricsRecordingHeader } from '@livekit/protocol';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import {
  type Attributes,
  type Context,
  ProxyTracerProvider,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import type {
  ReadableSpan,
  Span as SdkSpan,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import FormData from 'form-data';
import { AccessToken } from 'livekit-server-sdk';
import fs from 'node:fs/promises';
import type { ChatItem } from '../llm/index.js';
import { enableOtelLogging } from '../log.js';
import { filterZeroValues } from '../metrics/model_usage.js';
import { encodeChatItem } from '../proto.js';
import {
  ATTRIBUTE_REDACTION_ENABLED,
  ATTRIBUTE_SIMULATION_ENABLED,
  recordingEnabled,
} from '../types.js';
import { version } from '../version.js';
import { type SessionReport, sessionReportToJSON } from '../voice/report.js';
import { type SimpleLogRecord, SimpleOTLPHttpLogExporter } from './otel_http_exporter.js';
import { flushPinoLogs, initPinoCloudExporter } from './pino_otel_transport.js';
import { ATTR_AGENT_NAME, ATTR_CLOUD_AGENT_ID, ATTR_DEPLOYMENT_ID } from './trace_types.js';
import { UploadGateTraceExporter, uploadGate } from './upload_gate.js';

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

/** @deprecated Use OpenTelemetry SDK 2.x's `SpanProcessor` type directly. */
export type SpanProcessorLike = SpanProcessor;

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
   * Returns the current tracer provider — the API's ProxyTracerProvider if none has been set
   * via setProvider(), which callers use to detect whether a user-configured provider exists.
   */
  getProvider(): TracerProvider {
    return this.tracerProvider;
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
    return ThrowsPromise.resolve();
  }

  forceFlush(): Promise<void> {
    return ThrowsPromise.resolve();
  }
}

type SpanProcessorRegistrar = (spanProcessor: SpanProcessor) => void;

/**
 * Span processor that forwards to a list of processors that can grow after the owning provider
 * is constructed.
 *
 * OpenTelemetry 2.x providers accept span processors only at construction time. Include one of
 * these in the provider's `spanProcessors` and pass its {@link FanoutSpanProcessor.add | add}
 * method as `registerSpanProcessor` so LiveKit Cloud tracing can attach its processors later.
 */
export class FanoutSpanProcessor implements SpanProcessor {
  private readonly processors: SpanProcessor[] = [];

  /** Adds a processor that receives all span events from this point on. */
  add(processor: SpanProcessor): void {
    this.processors.push(processor);
  }

  onStart(span: SdkSpan, parentContext: Context): void {
    for (const processor of this.processors) {
      processor.onStart(span, parentContext);
    }
  }

  onEnding(span: SdkSpan): void {
    for (const processor of this.processors) {
      processor.onEnding?.(span);
    }
  }

  onEnd(span: ReadableSpan): void {
    for (const processor of this.processors) {
      processor.onEnd(span);
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.processors.map((processor) => processor.forceFlush()));
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.processors.map((processor) => processor.shutdown()));
  }
}

/** Inputs for building a span processor that exports to LiveKit Cloud. */
export interface CloudSpanProcessorOptions {
  /** OTLP/HTTP protobuf endpoint for LiveKit Cloud traces. */
  url: string;
  /** Request headers, including the authorization token, the exporter must send. */
  headers: Record<string, string>;
  /** Framework-owned exporter that applies LiveKit Cloud's recording-disabled upload gate. */
  exporter: SpanExporter;
}

interface CustomProviderConfig {
  registerSpanProcessor: SpanProcessorRegistrar;
  createCloudSpanProcessor?: (options: CloudSpanProcessorOptions) => SpanProcessor;
}

const customProviderConfigs = new WeakMap<TracerProvider, CustomProviderConfig>();

/** Options for configuring a custom tracer provider. */
export interface SetTracerProviderOptions {
  /** Attributes to add to every span created by the provider. */
  metadata?: Attributes;
  /**
   * Adds a span processor to the provider.
   *
   * OpenTelemetry 2.x providers no longer expose `addSpanProcessor`. Supply this callback when
   * using a provider backed by a mutable or delegating span processor so LiveKit Cloud tracing can
   * share the same provider as another observability backend.
   */
  registerSpanProcessor?: SpanProcessorRegistrar;
  /**
   * Builds the span processor that exports to LiveKit Cloud, called when cloud tracing starts.
   *
   * The built-in OpenTelemetry SDK 2.x cloud processor is used by default. Supply this callback
   * only to override how that processor is constructed:
   *
   * ```typescript
   * import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
   *
   * createCloudSpanProcessor: ({ exporter }) => new BatchSpanProcessor(exporter)
   * ```
   *
   * Build the processor around the supplied exporter so the recording-disabled upload gate remains
   * active. The returned processor must use OpenTelemetry SDK 2.x.
   */
  createCloudSpanProcessor?: (options: CloudSpanProcessorOptions) => SpanProcessor;
}

/**
 * Set the tracer provider for the livekit-agents framework.
 * This should be called before agent session start if using custom tracer providers.
 *
 * @param provider - The tracer provider to use
 * @param options - Optional provider configuration
 *
 * @example OpenTelemetry SDK 2.x — share one provider between another backend and LiveKit Cloud.
 * SDK 2.x providers accept span processors only at construction time, so the provider must be
 * built around a processor whose targets can grow later ({@link FanoutSpanProcessor}). The
 * built-in cloud exporter is SDK 2.x and is attached through the fanout automatically.
 * ```typescript
 * import { telemetry } from '@livekit/agents';
 * import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
 *
 * const fanout = new telemetry.FanoutSpanProcessor();
 * const provider = new NodeTracerProvider({
 *   spanProcessors: [new BatchSpanProcessor(myBackendExporter), fanout],
 * });
 * provider.register();
 * telemetry.setTracerProvider(provider, {
 *   metadata: { room_id: 'room123', job_id: 'job456' },
 *   registerSpanProcessor: (processor) => fanout.add(processor),
 * });
 * ```
 */
export function setTracerProvider(
  provider: TracerProvider,
  options?: SetTracerProviderOptions,
): void {
  const registerSpanProcessor = options?.registerSpanProcessor;

  if (options?.metadata) {
    if (registerSpanProcessor) {
      registerSpanProcessor(new MetadataSpanProcessor(options.metadata));
    } else {
      console.warn(
        'Unable to register LiveKit span metadata on the custom tracer provider. ' +
          'Pass registerSpanProcessor to setTracerProvider when using OpenTelemetry 2.x.',
      );
    }
  }

  if (options?.createCloudSpanProcessor && !registerSpanProcessor) {
    console.warn(
      'Ignoring createCloudSpanProcessor because the custom tracer provider has no way to ' +
        'register span processors. Pass registerSpanProcessor to setTracerProvider when using ' +
        'OpenTelemetry 2.x.',
    );
  }

  if (registerSpanProcessor) {
    customProviderConfigs.set(provider, {
      registerSpanProcessor,
      createCloudSpanProcessor: options?.createCloudSpanProcessor,
    });
  } else {
    customProviderConfigs.delete(provider);
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
  agentName?: string;
  enableTraces?: boolean;
  enableLogs?: boolean;
  metadata?: Attributes;
}): Promise<void> {
  uploadGate.reset();

  const {
    roomId,
    jobId,
    cloudHostname,
    agentName,
    enableTraces = true,
    enableLogs = true,
  } = options;

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

    const baseMetadata: Attributes = {
      room_id: roomId,
      job_id: jobId,
    };
    if (agentName) {
      // identifies the agent for LiveKit Cloud agent insights (explicit dispatch
      // only; the default dispatch has no agent name). Included in both the
      // resource (traces) and the session metadata (spans + logs).
      baseMetadata[ATTR_AGENT_NAME] = agentName;
    }

    // cloud agent id and deployment provided by LiveKit Cloud via env vars.
    // Included in both the resource and the session metadata like agentName;
    // omitted when unset.
    const cloudAgentId = process.env.LIVEKIT_AGENT_ID;
    if (cloudAgentId) {
      baseMetadata[ATTR_CLOUD_AGENT_ID] = cloudAgentId;
    }
    const deploymentId = process.env.LIVEKIT_AGENT_DEPLOYMENT;
    if (deploymentId) {
      baseMetadata[ATTR_DEPLOYMENT_ID] = deploymentId;
    }

    const sessionMetadata: Attributes = { ...baseMetadata, ...(options.metadata ?? {}) };

    const resource = defaultResource()
      .merge(detectResources({ detectors: [envDetector] }))
      .merge(
        resourceFromAttributes({
          [ATTR_SERVICE_NAME]: 'livekit-agents',
          ...baseMetadata,
        }),
      );

    if (enableTraces) {
      const url = `https://${cloudHostname}/observability/traces/otlp/v0`;
      const createCloudExporter = () =>
        new UploadGateTraceExporter({
          url,
          headers,
          compression: CompressionAlgorithm.GZIP,
        });

      // If the user already configured a tracer provider (e.g. setTracerProvider in the job
      // entrypoint), attach the cloud exporter to it rather than replacing it, so spans reach
      // both the user's backend and LiveKit Cloud.
      const currentProvider = tracer.getProvider();
      const existingProvider =
        currentProvider instanceof ProxyTracerProvider ? undefined : currentProvider;

      if (!existingProvider) {
        const tracerProvider = new NodeTracerProvider({
          resource,
          spanProcessors: [
            new MetadataSpanProcessor(sessionMetadata),
            new BatchSpanProcessor(createCloudExporter()),
          ],
        });
        // register() installs an AsyncLocalStorageContextManager (needed for span nesting)
        // and sets the global tracer provider. Both use set-once semantics in the OTel API,
        // so if the user already called NodeSDK.start(), these are safe no-ops.
        tracerProvider.register();
        setTracerProvider(tracerProvider);
      } else {
        const config = customProviderConfigs.get(existingProvider);

        if (!config) {
          console.warn(
            'LiveKit Cloud tracing is disabled because the custom tracer provider cannot register ' +
              'additional span processors. Pass registerSpanProcessor to setTracerProvider when ' +
              'using OpenTelemetry 2.x.',
          );
        } else {
          const cloudExporterOptions: CloudSpanProcessorOptions = {
            url,
            headers,
            exporter: createCloudExporter(),
          };
          const cloudSpanProcessor = config.createCloudSpanProcessor
            ? config.createCloudSpanProcessor(cloudExporterOptions)
            : new BatchSpanProcessor(cloudExporterOptions.exporter);

          // The user's provider keeps its own Resource (incl. service.name): a provider has one
          // Resource shared by all exporters, so applying `resource` here would also relabel
          // the spans going to the user's own backend. room_id/job_id — the keys Cloud
          // correlates on — still ride along as span attributes via MetadataSpanProcessor.
          config.registerSpanProcessor(new MetadataSpanProcessor(sessionMetadata));
          config.registerSpanProcessor(cloudSpanProcessor);
        }
      }
    }

    if (enableLogs) {
      // Initialize standalone Pino cloud exporter (no OTEL SDK dependency)
      initPinoCloudExporter({
        cloudHostname,
        roomId,
        jobId,
        metadata: options.metadata,
      });

      enableOtelLogging();
    }
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

/** Proto field names and shapes, matching what livekit/agents emits for the same log body. */
function chatItemSpanAttribute(item: ChatItem): Record<string, unknown> {
  return encodeChatItem(item).toJson({ useProtoFieldName: true }) as Record<string, unknown>;
}

const SESSION_OPTION_KEY_ALIASES: Record<string, string> = {
  keyterms: 'lk.pii.keyterms',
};

function serializeSessionOptions(options: SessionReport['options']): Record<string, unknown> {
  const serialize = (value: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        SESSION_OPTION_KEY_ALIASES[key] ?? key,
        nestedValue !== null &&
        typeof nestedValue === 'object' &&
        !Array.isArray(nestedValue) &&
        (Object.getPrototypeOf(nestedValue) === Object.prototype ||
          Object.getPrototypeOf(nestedValue) === null)
          ? serialize(nestedValue as Record<string, unknown>)
          : nestedValue,
      ]),
    );

  return serialize(options as unknown as Record<string, unknown>);
}

/**
 * Upload session report to LiveKit Cloud observability.
 * @param options - Configuration with agentName, cloudHostname, and report
 */
export async function uploadSessionReport(options: {
  agentName: string;
  cloudHostname: string;
  report: SessionReport;
  metadata?: Attributes;
}): Promise<void> {
  const { agentName, cloudHostname, report } = options;
  const metadata = options.metadata ?? {};

  if (!recordingEnabled(report.options.recordingOptions)) {
    return;
  }
  if (uploadGate.disabled) {
    return;
  }

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
      ...metadata,
    },
  });

  // Build log records for session report and chat items
  const logRecords: SimpleLogRecord[] = [];

  const commonAttrs = {
    room_id: report.roomId,
    job_id: report.jobId,
    'logger.name': 'chat_history',
    ...metadata,
  };

  const usage = report.modelUsage?.map(filterZeroValues) || null;

  logRecords.push({
    body: 'session report',
    timestampMs: report.startedAt || report.timestamp || 0,
    attributes: {
      ...commonAttrs,
      'session.options': serializeSessionOptions(report.options),
      'session.report_timestamp': report.timestamp,
      agent_name: agentName,
      sdk_version: version,
      usage,
    },
  });

  // Track last timestamp to ensure monotonic ordering when items have identical timestamps
  // This fixes the issue where function_call and function_call_output with same timestamp
  // get reordered by the dashboard
  let lastTimestamp = 0;
  const chatItems = report.options.recordingOptions.transcript ? report.chatHistory.items : [];
  for (const item of chatItems) {
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

    const itemProto = chatItemSpanAttribute(item);
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
  if (uploadGate.disabled) {
    return;
  }

  const hasAudio = Boolean(
    report.options.recordingOptions.audio &&
      report.audioRecordingPath &&
      report.audioRecordingStartedAt,
  );
  // Nothing to send to the recordings endpoint when neither the transcript nor
  // audio is being captured.
  if (!report.options.recordingOptions.transcript && !hasAudio) {
    return;
  }

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
    jobId: report.jobId,
    duration: BigInt(0), // TODO: Calculate actual duration from report
    startTime: {
      seconds: BigInt(Math.floor(audioStartTime / 1000)),
      nanos: Math.floor((audioStartTime % 1000) * 1e6),
    },
    simulated: metadata[ATTRIBUTE_SIMULATION_ENABLED] === true,
    redactionEnabled: metadata[ATTRIBUTE_REDACTION_ENABLED] === true,
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

  // Add chat_history JSON (only when transcript recording is enabled).
  // Reuse the report layer's serialization so the uploaded chat history carries the
  // snake_case (Python wire) field names — chat-item toJSON() emits camelCase, and the
  // snake_case conversion lives only in sessionReportToJSON (toSnakeCaseDeep). Serializing
  // raw toJSON() here would send camelCase and fail the Python consumer's pydantic validation
  // (e.g. call_id/arguments/is_error/new_agent_id reported as missing).
  if (report.options.recordingOptions.transcript) {
    const chatHistoryJson = JSON.stringify(sessionReportToJSON(report).chat_history);
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
  }

  // Add audio recording file if available
  if (
    report.options.recordingOptions.audio &&
    report.audioRecordingPath &&
    report.audioRecordingStartedAt
  ) {
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
  return new ThrowsPromise<void, Error>((resolve, reject) => {
    const uploadGeneration = uploadGate.generation;
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
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => {
            chunks.push(Buffer.from(chunk));
          });
          res.on('error', (readErr) => {
            reject(
              new Error(
                `Failed to upload session report: ${res.statusCode} ${res.statusMessage} (body read error: ${readErr.message})`,
              ),
            );
          });
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            if (uploadGate.isDisabledResponse(res.statusCode ?? 0, body)) {
              uploadGate.disable(uploadGeneration);
              resolve();
              return;
            }
            reject(
              new Error(
                `Failed to upload session report: ${res.statusCode} ${res.statusMessage} - ${body.toString('utf8')}`,
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
