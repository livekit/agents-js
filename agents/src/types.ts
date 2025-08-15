// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export class APIConnectOptions {
  /** Maximum number of retries to connect to the API. */
  readonly maxRetry: number;
  /** Interval between retries to connect to the API in milliseconds. */
  readonly retryIntervalMs: number;
  /** Timeout for connecting to the API in milliseconds. */
  readonly timeoutMs: number;

  constructor(options: Partial<APIConnectOptions> = {}) {
    this.maxRetry = options.maxRetry ?? 3;
    this.retryIntervalMs = options.retryIntervalMs ?? 2000;
    this.timeoutMs = options.timeoutMs ?? 10000;

    if (this.maxRetry < 0) {
      throw new Error('maxRetry must be greater than or equal to 0');
    }
    if (this.retryIntervalMs < 0) {
      throw new Error('retryIntervalMs must be greater than or equal to 0');
    }
    if (this.timeoutMs < 0) {
      throw new Error('timeoutMs must be greater than or equal to 0');
    }
  }

  /** @internal */
  _intervalForRetry(numRetries: number): number {
    /**
     * Return the interval for the given number of retries.
     *
     * The first retry is immediate, and then uses specified retryIntervalMs
     */
    if (numRetries === 0) {
      return 0.1;
    }
    return this.retryIntervalMs;
  }
}

export const DEFAULT_API_CONNECT_OPTIONS = new APIConnectOptions();
