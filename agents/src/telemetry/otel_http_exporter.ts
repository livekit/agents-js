// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Raw HTTP OTLP JSON Log Exporter
 *
 * This module provides a custom OTLP log exporter that uses raw HTTP with JSON format
 * instead of the default protobuf format. This is necessary because some backends
 * (including LiveKit Cloud) require JSON format for log ingestion.
 *
 * @internal
 */
import { AccessToken } from 'livekit-server-sdk';

/**
 * Severity levels matching OpenTelemetry specification
 */
export enum OTLPSeverityNumber {
  UNSPECIFIED = 0,
  TRACE = 1,
  DEBUG = 5,
  INFO = 9,
  WARN = 13,
  ERROR = 17,
  FATAL = 21,
}

/**
 * A log record to be exported via OTLP JSON
 */
export interface OTLPLogRecord {
  /** Log message body */
  body: string;
  /** Timestamp in milliseconds since epoch */
  timestampMs: number;
  /** Log attributes (will be converted to OTLP format) */
  attributes: Record<string, unknown>;
  /** Severity number (default: UNSPECIFIED) */
  severityNumber?: OTLPSeverityNumber;
  /** Severity text (default: 'unspecified') */
  severityText?: string;
}

/**
 * Configuration for the OTLP HTTP Log Exporter
 */
export interface OTLPHttpLogExporterConfig {
  /** LiveKit Cloud hostname (e.g., 'cloud.livekit.io') */
  cloudHostname: string;
  /** Resource attributes (e.g., room_id, job_id) */
  resourceAttributes: Record<string, string>;
  /** Scope name for the logger (e.g., 'chat_history') */
  scopeName: string;
  /** Scope attributes */
  scopeAttributes?: Record<string, string>;
}

/**
 * OTLP HTTP Log Exporter using JSON format
 *
 * This exporter sends log records to LiveKit Cloud using the OTLP JSON format
 * over HTTP. It handles JWT authentication and proper serialization.
 *
 * @example
 * ```typescript
 * const exporter = new OTLPHttpLogExporter({
 *   cloudHostname: 'cloud.livekit.io',
 *   resourceAttributes: { room_id: 'xxx', job_id: 'yyy' },
 *   scopeName: 'chat_history',
 *   scopeAttributes: { room: 'room-name' },
 * });
 *
 * await exporter.export([
 *   { body: 'Hello', timestampMs: Date.now(), attributes: { test: true } },
 * ]);
 * ```
 */
export class OTLPHttpLogExporter {
  private readonly config: OTLPHttpLogExporterConfig;
  private jwt: string | null = null;

  constructor(config: OTLPHttpLogExporterConfig) {
    this.config = config;
  }

  /**
   * Export log records to LiveKit Cloud
   *
   * @param records - Array of log records to export
   * @throws Error if API credentials are not set or export fails
   */
  async export(records: OTLPLogRecord[]): Promise<void> {
    if (records.length === 0) return;

    // Ensure we have a valid JWT
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
   * Build the OTLP JSON payload
   */
  private buildPayload(records: OTLPLogRecord[]): object {
    const resourceAttrs = Object.entries(this.config.resourceAttributes).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }));

    // Add service.name if not present
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
      // Convert milliseconds to nanoseconds, preserving microsecond precision for ordering
      timeUnixNano: String(BigInt(Math.floor(record.timestampMs * 1_000_000))),
      observedTimeUnixNano: String(BigInt(Date.now()) * BigInt(1_000_000)),
      severityNumber: record.severityNumber ?? OTLPSeverityNumber.UNSPECIFIED,
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

  /**
   * Convert JS attributes to OTLP attribute format
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

    // Fallback to string
    return { stringValue: String(value) };
  }
}
