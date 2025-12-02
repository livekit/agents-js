// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom Pino OTEL Transport
 *
 * Standalone exporter for Pino logs to LiveKit Cloud.
 * Uses raw HTTP JSON format, bypassing the OTEL SDK.
 */
import { SeverityNumber } from '@opentelemetry/api-logs';
import { AccessToken } from 'livekit-server-sdk';

export interface PinoLogObject {
  level: number;
  time: number;
  msg: string;
  pid?: number;
  hostname?: string;
  [key: string]: unknown;
}

export interface PinoCloudExporterConfig {
  cloudHostname: string;
  roomId: string;
  jobId: string;
  loggerName?: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

function mapPinoLevelToSeverity(pinoLevel: number): {
  severityNumber: SeverityNumber;
  severityText: string;
} {
  if (pinoLevel <= 10) {
    return { severityNumber: SeverityNumber.TRACE, severityText: 'TRACE' };
  } else if (pinoLevel <= 20) {
    return { severityNumber: SeverityNumber.DEBUG, severityText: 'DEBUG' };
  } else if (pinoLevel <= 30) {
    return { severityNumber: SeverityNumber.INFO, severityText: 'INFO' };
  } else if (pinoLevel <= 40) {
    return { severityNumber: SeverityNumber.WARN, severityText: 'WARN' };
  } else if (pinoLevel <= 50) {
    return { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' };
  } else {
    return { severityNumber: SeverityNumber.FATAL, severityText: 'FATAL' };
  }
}

const EXCLUDE_FIELDS = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v']);

function convertValue(value: unknown): unknown {
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
  if (typeof value === 'object') {
    return { stringValue: JSON.stringify(value) };
  }
  return { stringValue: String(value) };
}

/**
 * Standalone Pino log exporter for LiveKit Cloud.
 *
 * Collects Pino logs, batches them, and sends via raw HTTP JSON.
 * No OTEL SDK dependency
 *
 * @example
 * ```typescript
 * const exporter = new PinoCloudExporter({
 *   cloudHostname: 'cloud.livekit.io',
 *   roomId: 'RM_xxx',
 *   jobId: 'AJ_xxx',
 * });
 *
 * // In Pino formatter hook:
 * exporter.emit(logObj);
 *
 * // On session end:
 * await exporter.flush();
 * ```
 */
export class PinoCloudExporter {
  private readonly config: PinoCloudExporterConfig;
  private readonly loggerName: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private jwt: string | null = null;
  private pendingLogs: any[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config: PinoCloudExporterConfig) {
    this.config = config;
    this.loggerName = config.loggerName || 'livekit.agents';
    this.batchSize = config.batchSize || 100;
    this.flushIntervalMs = config.flushIntervalMs || 5000;
  }

  emit(logObj: PinoLogObject): void {
    const record = this.convertToOtlpRecord(logObj);
    this.pendingLogs.push(record);

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch(console.error);
      }, this.flushIntervalMs);
    }

    if (this.pendingLogs.length >= this.batchSize) {
      this.flush().catch(console.error);
    }
  }

  private convertToOtlpRecord(logObj: PinoLogObject): any {
    const { severityNumber, severityText } = mapPinoLevelToSeverity(logObj.level);

    const attributes: any[] = [
      { key: 'room_id', value: { stringValue: this.config.roomId } },
      { key: 'job_id', value: { stringValue: this.config.jobId } },
      { key: 'logger.name', value: { stringValue: this.loggerName } },
    ];

    if (logObj.pid !== undefined) {
      attributes.push({ key: 'process.pid', value: { intValue: String(logObj.pid) } });
    }
    if (logObj.hostname !== undefined) {
      attributes.push({ key: 'host.name', value: { stringValue: logObj.hostname } });
    }

    for (const [key, value] of Object.entries(logObj)) {
      if (!EXCLUDE_FIELDS.has(key)) {
        attributes.push({ key, value: convertValue(value) });
      }
    }

    return {
      timeUnixNano: String(BigInt(logObj.time) * BigInt(1_000_000)),
      observedTimeUnixNano: String(BigInt(Date.now()) * BigInt(1_000_000)),
      severityNumber,
      severityText,
      body: { stringValue: logObj.msg || '' },
      attributes,
      traceId: '',
      spanId: '',
    };
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pendingLogs.length === 0) {
      return;
    }

    const logs = this.pendingLogs;
    this.pendingLogs = [];

    try {
      await this.sendLogs(logs);
    } catch (error) {
      this.pendingLogs = [...logs, ...this.pendingLogs];
      console.error('[PinoCloudExporter] Failed to flush logs:', error);
    }
  }

  private async sendLogs(logRecords: any[]): Promise<void> {
    await this.ensureJwt();

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'livekit-agents' } },
              { key: 'room_id', value: { stringValue: this.config.roomId } },
              { key: 'job_id', value: { stringValue: this.config.jobId } },
            ],
          },
          scopeLogs: [
            {
              scope: {
                name: this.loggerName,
                attributes: [
                  { key: 'room_id', value: { stringValue: this.config.roomId } },
                  { key: 'job_id', value: { stringValue: this.config.jobId } },
                ],
              },
              logRecords,
            },
          ],
        },
      ],
    };

    const endpoint = `https://${this.config.cloudHostname}/observability/logs/otlp/v0`;

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
      throw new Error(`Log export failed: ${response.status} ${response.statusText} - ${text}`);
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

  async shutdown(): Promise<void> {
    await this.flush();
  }
}

let globalExporter: PinoCloudExporter | null = null;

export function initPinoCloudExporter(config: PinoCloudExporterConfig): void {
  globalExporter = new PinoCloudExporter(config);
}

export function getPinoCloudExporter(): PinoCloudExporter | null {
  return globalExporter;
}

export function emitToOtel(logObj: PinoLogObject): void {
  if (globalExporter) {
    globalExporter.emit(logObj);
  }
}

export async function flushPinoLogs(): Promise<void> {
  if (globalExporter) {
    await globalExporter.flush();
  }
}
