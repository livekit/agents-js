// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export class PeriodicCollector<T> {
  private duration: number;
  private callback: (value: T) => void;
  private lastFlushTime: number;
  private total: T | null = null;

  constructor(callback: (value: T) => void, options: { duration: number }) {
    this.duration = options.duration;
    this.callback = callback;
    this.lastFlushTime = performance.now() / 1000;
  }

  push(value: T): void {
    if (this.total === null) {
      this.total = value;
    } else {
      this.total = (this.total as any) + (value as any);
    }

    if (performance.now() / 1000 - this.lastFlushTime >= this.duration) {
      this.flush();
    }
  }

  flush(): void {
    if (this.total !== null) {
      this.callback(this.total);
      this.total = null;
    }
    this.lastFlushTime = performance.now() / 1000;
  }
}
