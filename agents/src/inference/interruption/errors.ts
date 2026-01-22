/**
 * Error thrown during interruption detection.
 */
export class InterruptionDetectionError extends Error {
  readonly type = 'InterruptionDetectionError';

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
