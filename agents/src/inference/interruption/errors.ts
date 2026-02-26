// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Error thrown during interruption detection.
 */
// Ref: python inference/interruption.py InterruptionDetectionError
export class InterruptionDetectionError extends Error {
  readonly type = 'interruption_detection_error' as const;

  readonly timestamp: number;
  readonly label: string;
  readonly recoverable: boolean;

  constructor(message: string, timestamp: number, label: string, recoverable: boolean) {
    super(message);
    this.name = 'InterruptionDetectionError';
    this.timestamp = timestamp;
    this.label = label;
    this.recoverable = recoverable;
  }

  toString(): string {
    return `${this.name}: ${this.message} (label=${this.label}, timestamp=${this.timestamp}, recoverable=${this.recoverable})`;
  }
}
