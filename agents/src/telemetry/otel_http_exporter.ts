// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * OTLP HTTP JSON Log Exporter for LiveKit Cloud
 *
 * This module provides a custom OTLP log exporter that uses HTTP with JSON format
 * instead of the default protobuf format.
 */
import { SeverityNumber } from '@opentelemetry/api-logs';
import { AccessToken } from 'livekit-server-sdk';

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

    const logRecords = records.map((record) => {
      // Ensure timestampMs is a valid number, fallback to current time if NaN/undefined
      const timestampMs = Number.isFinite(record.timestampMs) ? record.timestampMs : Date.now();
      return {
        timeUnixNano: String(BigInt(Math.floor(timestampMs * 1_000_000))),
        observedTimeUnixNano: String(BigInt(Date.now()) * BigInt(1_000_000)),
        severityNumber: record.severityNumber ?? SeverityNumber.UNSPECIFIED,
        severityText: record.severityText ?? 'unspecified',
        body: { stringValue: record.body },
        attributes: this.convertAttributes(record.attributes),
        traceId: '',
        spanId: '',
      };
    });

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
