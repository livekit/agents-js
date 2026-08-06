// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { Attributes } from '@opentelemetry/api';
import type { LogRecordProcessor, SdkLogRecord } from '@opentelemetry/sdk-logs';

/**
 * Metadata log processor that injects metadata (room_id, job_id) into all log records.
 */
export class MetadataLogProcessor implements LogRecordProcessor {
  private metadata: Attributes;

  constructor(metadata: Attributes) {
    this.metadata = metadata;
  }

  onEmit(logRecord: SdkLogRecord): void {
    // Add metadata to log record attributes
    logRecord.setAttributes(this.metadata);
  }

  shutdown(): Promise<void> {
    return ThrowsPromise.resolve();
  }

  forceFlush(): Promise<void> {
    return ThrowsPromise.resolve();
  }
}

/**
 * Extra details processor that adds logger name to log records.
 */
export class ExtraDetailsProcessor implements LogRecordProcessor {
  onEmit(logRecord: SdkLogRecord): void {
    logRecord.setAttribute('logger.name', logRecord.instrumentationScope.name);
  }

  shutdown(): Promise<void> {
    return ThrowsPromise.resolve();
  }

  forceFlush(): Promise<void> {
    return ThrowsPromise.resolve();
  }
}
