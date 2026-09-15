// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { Attributes } from '@opentelemetry/api';
import type { LogRecordProcessor, SdkLogRecord } from '@opentelemetry/sdk-logs';
import {
  REDACTED_EXCEPTION_ATTRIBUTES,
  REDACTED_EXCEPTION_MESSAGE,
  isPIIAttribute,
  redactionEnabledFromAttributes as redactionEnabled,
} from './redaction.js';
import * as traceTypes from './trace_types.js';

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

/**
 * Log counterpart of `PIIFilteringSpanProcessor`, for a logger provider the integrator
 * builds themselves.
 *
 * Once the project mandates redaction the filtering applies to every destination, so the
 * client never depends on a collector to strip a newly added key. Register it ahead of any
 * exporting processor.
 */
export class PIIFilteringLogProcessor implements LogRecordProcessor {
  onEmit(logRecord: SdkLogRecord): void {
    if (!redactionEnabled(logRecord.attributes as Record<string, unknown>)) return;

    for (const key of Object.keys(logRecord.attributes)) {
      if (key === traceTypes.ATTR_EXCEPTION_MESSAGE) {
        logRecord.setAttribute(key, REDACTED_EXCEPTION_MESSAGE);
      } else if (isPIIAttribute(key) || REDACTED_EXCEPTION_ATTRIBUTES.has(key)) {
        delete (logRecord.attributes as Record<string, unknown>)[key];
      }
    }
  }

  shutdown(): Promise<void> {
    return ThrowsPromise.resolve();
  }

  forceFlush(): Promise<void> {
    return ThrowsPromise.resolve();
  }
}
