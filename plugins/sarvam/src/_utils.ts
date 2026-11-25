// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Accumulates pushed numeric values and reports the total on a fixed interval. */
export class PeriodicCollector {
  private duration: number;
  private callback: (value: number) => void;
  private lastFlushTime: number;
  private total: number | null = null;

  /**
   * @param callback - function to call with the accumulated value when the duration expires
   * @param options - options object
   */
  constructor(callback: (value: number) => void, options: { duration: number }) {
    this.duration = options.duration;
    this.callback = callback;
    this.lastFlushTime = performance.now() / 1000;
  }

  /** Add a value to the accumulator. */
  push(value: number): void {
    this.total = this.total === null ? value : this.total + value;

    if (performance.now() / 1000 - this.lastFlushTime >= this.duration) {
      this.flush();
    }
  }

  /** Force the callback to be called with the current total if non-zero. */
  flush(): void {
    if (this.total !== null) {
      this.callback(this.total);
      this.total = null;
    }
    this.lastFlushTime = performance.now() / 1000;
  }
}
