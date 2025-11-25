// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * OTLP HTTP JSON Log Exporter for LiveKit Cloud
 *
 * This module provides a custom OTLP log exporter that uses HTTP with JSON format
 * instead of the default protobuf format. This is necessary because LiveKit Cloud
 * requires JSON format for log ingestion.
 *
 * Implements the official OpenTelemetry LogRecordExporter interface.
 *
 * @internal
 */
import { SeverityNumber } from '@opentelemetry/api-logs';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { AccessToken } from 'livekit-server-sdk';

// Re-export for convenience
export { SeverityNumber } from '@opentelemetry/api-logs';
export { ExportResultCode } from '@opentelemetry/core';
export type { ExportResult } from '@opentelemetry/core';

/**
 * Configuration for the OTLP HTTP Log Exporter
 */
export interface OTLPHttpLogExporterConfig {
  /** LiveKit Cloud hostname (e.g., 'cloud.livekit.io') */
  cloudHostname: string;
  /** Concurrency limit for parallel exports (default: 30) */
  concurrencyLimit?: number;
}

/**
 * OTLP HTTP Log Exporter using JSON format
 *
 * Implements the official OpenTelemetry LogRecordExporter interface.
 * Sends log records to LiveKit Cloud using the OTLP JSON format over HTTP.
 *
 * @example
 * ```typescript
 * import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
 *
 * const exporter = new OTLPHttpLogExporter({
 *   cloudHostname: 'cloud.livekit.io',
 * });
 *
 * const loggerProvider = new LoggerProvider();
 * loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(exporter));
 *
 * const logger = loggerProvider.getLogger('my-logger');
 * logger.emit({ body: 'Hello World', severityNumber: SeverityNumber.INFO });
 * ```
 */
export class OTLPHttpLogExporter implements LogRecordExporter {
  private readonly config: OTLPHttpLogExporterConfig;
  private readonly concurrencyLimit: number;
  private readonly sendingPromises: Promise<unknown>[] = [];
  private jwt: string | null = null;
  private isShutdown = false;

  constructor(config: OTLPHttpLogExporterConfig) {
    this.config = config;
    this.concurrencyLimit = config.concurrencyLimit ?? 30;
  }

  /**
   * Export log records (implements LogRecordExporter interface)
   */
  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    if (this.isShutdown) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Exporter has been shutdown'),
      });
      return;
    }

    if (logs.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    if (this.sendingPromises.length >= this.concurrencyLimit) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Concurrency limit reached'),
      });
      return;
    }

    const promise = this.doSend(logs)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch((error) => {
        resultCallback({ code: ExportResultCode.FAILED, error });
      });

    this.sendingPromises.push(promise);
    promise.finally(() => {
      const index = this.sendingPromises.indexOf(promise);
      if (index !== -1) {
        this.sendingPromises.splice(index, 1);
      }
    });
  }

  /**
   * Shutdown the exporter (implements LogRecordExporter interface)
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }
    this.isShutdown = true;
    await Promise.all(this.sendingPromises);
    this.jwt = null;
  }

  /**
   * Force flush pending exports
   */
  async forceFlush(): Promise<void> {
    await Promise.all(this.sendingPromises);
  }

  /**
   * Internal send implementation
   */
  private async doSend(logs: ReadableLogRecord[]): Promise<void> {
    await this.ensureJwt();

    const endpoint = `https://${this.config.cloudHostname}/observability/logs/otlp/v0`;
    const payload = this.buildPayload(logs);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OTLP log export failed: ${response.status} ${response.statusText} - ${text}`,
      );
    }
  }

  /**
   * Ensure we have a valid JWT token
   */
  private async ensureJwt(): Promise<void> {
    if (this.jwt) return;

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set');
    }

    const token = new AccessToken(apiKey, apiSecret, { ttl: '6h' });
    token.addObservabilityGrant({ write: true });
    this.jwt = await token.toJwt();
  }

  /**
   * Build the OTLP JSON payload from ReadableLogRecords
   */
  private buildPayload(logs: ReadableLogRecord[]): object {
    // Group logs by resource and scope
    const resourceMap = new Map<
      string,
      { resource: object; scopeMap: Map<string, ReadableLogRecord[]> }
    >();

    for (const log of logs) {
      const resourceKey = JSON.stringify(log.resource.attributes);
      let resourceEntry = resourceMap.get(resourceKey);
      if (!resourceEntry) {
        resourceEntry = {
          resource: { attributes: this.convertAttributes(log.resource.attributes) },
          scopeMap: new Map(),
        };
        resourceMap.set(resourceKey, resourceEntry);
      }

      const scopeKey = log.instrumentationScope.name;
      let scopeLogs = resourceEntry.scopeMap.get(scopeKey);
      if (!scopeLogs) {
        scopeLogs = [];
        resourceEntry.scopeMap.set(scopeKey, scopeLogs);
      }
      scopeLogs.push(log);
    }

    // Build the OTLP structure
    const resourceLogs = Array.from(resourceMap.values()).map((entry) => ({
      resource: entry.resource,
      scopeLogs: Array.from(entry.scopeMap.entries()).map(([scopeName, scopeLogs]) => ({
        scope: { name: scopeName },
        logRecords: scopeLogs.map((log) => this.convertLogRecord(log)),
      })),
    }));

    return { resourceLogs };
  }

  /**
   * Convert a ReadableLogRecord to OTLP JSON format
   */
  private convertLogRecord(log: ReadableLogRecord): object {
    return {
      timeUnixNano: this.hrTimeToNano(log.hrTime),
      observedTimeUnixNano: this.hrTimeToNano(log.hrTimeObserved),
      severityNumber: log.severityNumber ?? SeverityNumber.UNSPECIFIED,
      severityText: log.severityText ?? 'unspecified',
      body: this.convertValue(log.body),
      attributes: this.convertAttributes(log.attributes),
      traceId: log.spanContext?.traceId ?? '',
      spanId: log.spanContext?.spanId ?? '',
    };
  }

  /**
   * Convert HrTime [seconds, nanoseconds] to nanoseconds string
   */
  private hrTimeToNano(hrTime: [number, number]): string {
    const [seconds, nanos] = hrTime;
    return String(BigInt(seconds) * BigInt(1_000_000_000) + BigInt(nanos));
  }

  /**
   * Convert attributes object to OTLP format
   */
  private convertAttributes(
    attrs: Record<string, unknown>,
  ): Array<{ key: string; value: unknown }> {
    return Object.entries(attrs).map(([key, value]) => ({
      key,
      value: this.convertValue(value),
    }));
  }

  /**
   * Convert a JS value to OTLP value format
   */
  private convertValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return { stringValue: '' };
    }

    if (typeof value === 'string') {
      return { stringValue: value };
    }

    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return { intValue: String(value) };
      }
      return { doubleValue: value };
    }

    if (typeof value === 'boolean') {
      return { boolValue: value };
    }

    if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map((v) => this.convertValue(v)),
        },
      };
    }

    if (typeof value === 'object') {
      return {
        kvlistValue: {
          values: Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
            key: k,
            value: this.convertValue(v),
          })),
        },
      };
    }

    return { stringValue: String(value) };
  }
}

/**
 * Simple log record for direct export (bypasses SDK LoggerProvider)
 *
 * Use this when you need to export logs directly without going through
 * the SDK's LoggerProvider infrastructure.
 */
export interface SimpleLogRecord {
  /** Log message body */
  body: string;
  /** Timestamp in milliseconds since epoch */
  timestampMs: number;
  /** Log attributes */
  attributes: Record<string, unknown>;
  /** Severity number (default: UNSPECIFIED) */
  severityNumber?: SeverityNumber;
  /** Severity text (default: 'unspecified') */
  severityText?: string;
}

/**
 * Configuration for SimpleOTLPHttpLogExporter
 */
export interface SimpleOTLPHttpLogExporterConfig {
  /** LiveKit Cloud hostname */
  cloudHostname: string;
  /** Resource attributes (e.g., room_id, job_id) */
  resourceAttributes: Record<string, string>;
  /** Scope name for the logger */
  scopeName: string;
  /** Scope attributes */
  scopeAttributes?: Record<string, string>;
}

/**
 * Simple OTLP HTTP Log Exporter for direct log export
 *
 * This is a simplified exporter that doesn't require the full SDK infrastructure.
 * Use this when you need to send logs directly without LoggerProvider.
 *
 * @example
 * ```typescript
 * const exporter = new SimpleOTLPHttpLogExporter({
 *   cloudHostname: 'cloud.livekit.io',
 *   resourceAttributes: { room_id: 'xxx', job_id: 'yyy' },
 *   scopeName: 'chat_history',
 * });
 *
 * await exporter.export([
 *   { body: 'Hello', timestampMs: Date.now(), attributes: { test: true } },
 * ]);
 * ```
 */
export class SimpleOTLPHttpLogExporter {
  private readonly config: SimpleOTLPHttpLogExporterConfig;
  private jwt: string | null = null;

  constructor(config: SimpleOTLPHttpLogExporterConfig) {
    this.config = config;
  }

  /**
   * Export simple log records
   */
  async export(records: SimpleLogRecord[]): Promise<void> {
    if (records.length === 0) return;

    await this.ensureJwt();

    const endpoint = `https://${this.config.cloudHostname}/observability/logs/otlp/v0`;
    const payload = this.buildPayload(records);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OTLP log export failed: ${response.status} ${response.statusText} - ${text}`,
      );
    }
  }

  private async ensureJwt(): Promise<void> {
    if (this.jwt) return;

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set');
    }

    const token = new AccessToken(apiKey, apiSecret, { ttl: '6h' });
    token.addObservabilityGrant({ write: true });
    this.jwt = await token.toJwt();
  }

  private buildPayload(records: SimpleLogRecord[]): object {
    const resourceAttrs = Object.entries(this.config.resourceAttributes).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }));

    if (!this.config.resourceAttributes['service.name']) {
      resourceAttrs.push({ key: 'service.name', value: { stringValue: 'livekit-agents' } });
    }

    const scopeAttrs = this.config.scopeAttributes
      ? Object.entries(this.config.scopeAttributes).map(([key, value]) => ({
          key,
          value: { stringValue: value },
        }))
      : [];

    const logRecords = records.map((record) => ({
      timeUnixNano: String(BigInt(Math.floor(record.timestampMs * 1_000_000))),
      observedTimeUnixNano: String(BigInt(Date.now()) * BigInt(1_000_000)),
      severityNumber: record.severityNumber ?? SeverityNumber.UNSPECIFIED,
      severityText: record.severityText ?? 'unspecified',
      body: { stringValue: record.body },
      attributes: this.convertAttributes(record.attributes),
      traceId: '',
      spanId: '',
    }));

    return {
      resourceLogs: [
        {
          resource: { attributes: resourceAttrs },
          scopeLogs: [
            {
              scope: {
                name: this.config.scopeName,
                attributes: scopeAttrs,
              },
              logRecords,
            },
          ],
        },
      ],
    };
  }

  private convertAttributes(
    attrs: Record<string, unknown>,
  ): Array<{ key: string; value: unknown }> {
    return Object.entries(attrs).map(([key, value]) => ({
      key,
      value: this.convertValue(value),
    }));
  }

  private convertValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return { stringValue: '' };
    }
    if (typeof value === 'string') {
      return { stringValue: value };
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    }
    if (typeof value === 'boolean') {
      return { boolValue: value };
    }
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map((v) => this.convertValue(v)) } };
    }
    if (typeof value === 'object') {
      return {
        kvlistValue: {
          values: Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
            key: k,
            value: this.convertValue(v),
          })),
        },
      };
    }
    return { stringValue: String(value) };
  }
}
