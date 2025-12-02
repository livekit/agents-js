// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Attributes } from '@opentelemetry/api';
import type { LogRecord, LogRecordProcessor } from '@opentelemetry/sdk-logs';

/**
 * Metadata log processor that injects metadata (room_id, job_id) into all log records.
 */
export class MetadataLogProcessor implements LogRecordProcessor {
  private metadata: Attributes;

  constructor(metadata: Attributes) {
    this.metadata = metadata;
  }

  onEmit(logRecord: LogRecord): void {
    // Add metadata to log record attributes
    if (logRecord.attributes) {
      Object.assign(logRecord.attributes, this.metadata);
    } else {
      (logRecord as any).attributes = { ...this.metadata };
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Extra details processor that adds logger name to log records.
 */
export class ExtraDetailsProcessor implements LogRecordProcessor {
  onEmit(logRecord: LogRecord): void {
    const loggerName = logRecord.instrumentationScope.name;
    if (logRecord.attributes) {
      (logRecord.attributes as any)['logger.name'] = loggerName;
    } else {
      (logRecord as any).attributes = { 'logger.name': loggerName };
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
