// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Allows at most `limit` events per rolling minute and counts the ones it drops. @internal */
export class RateLimiter {
  readonly #limit: number;
  readonly #events: number[] = [];
  #suppressed = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  allow(now: number): boolean {
    const windowStart = now - 60_000;
    while (this.#events.length && this.#events[0]! < windowStart) this.#events.shift();
    if (this.#events.length >= this.#limit) {
      this.#suppressed++;
      return false;
    }
    this.#events.push(now);
    return true;
  }

  takeSuppressed(): number {
    const suppressed = this.#suppressed;
    this.#suppressed = 0;
    return suppressed;
  }
}
