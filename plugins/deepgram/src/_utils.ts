// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export class PeriodicCollector<T> {
  private duration: number;
  private callback: (value: T) => void;
  private lastFlushTime: number;
  private total: T | null = null;

  constructor(callback: (value: T) => void, options: { duration: number }) {
    /**
     * Create a new periodic collector that accumulates values and calls the callback
     * after the specified duration if there are values to report.
     *
     * @param callback Function to call with accumulated value when duration expires
     * @param options.duration Time in seconds between callback invocations
     */
    this.duration = options.duration;
    this.callback = callback;
    this.lastFlushTime = performance.now() / 1000; // Convert to seconds
  }

  push(value: T): void {
    /**
     * Add a value to the accumulator
     */
    if (this.total === null) {
      this.total = value;
    } else {
      // Type assertion needed for generic addition
      this.total = (this.total as any) + (value as any);
    }

    if (performance.now() / 1000 - this.lastFlushTime >= this.duration) {
      this.flush();
    }
  }

  flush(): void {
    /**
     * Force callback to be called with current total if non-zero
     */
    if (this.total !== null) {
      this.callback(this.total);
      this.total = null;
    }
    this.lastFlushTime = performance.now() / 1000;
  }
}
