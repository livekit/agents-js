// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { DEFAULT_API_CONNECT_OPTIONS, intervalForRetry } from './types.js';

describe('intervalForRetry', () => {
  const connOptions = { ...DEFAULT_API_CONNECT_OPTIONS, retryIntervalMs: 300 };

  it('returns milliseconds for every retry, including the first', () => {
    // Every caller passes this straight to setTimeout/delay, so both branches
    // have to be in the same unit. Python's equivalent waits 0.1s here.
    expect(intervalForRetry(connOptions, 0)).toBe(100);
    expect(intervalForRetry(connOptions, 1)).toBe(300);
    expect(intervalForRetry(connOptions, 2)).toBe(300);
  });

  it('waits noticeably before the first retry rather than reattempting at once', async () => {
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, intervalForRetry(connOptions, 0)));

    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
  });
});
