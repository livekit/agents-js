// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { APIStatusError } from './_exceptions.js';

describe('APIStatusError retryability defaults', () => {
  it('treats 408 as retryable by default', () => {
    const error = new APIStatusError({
      message: 'timeout',
      options: { statusCode: 408 },
    });
    expect(error.retryable).toBe(true);
  });

  it('treats 429 as retryable by default', () => {
    const error = new APIStatusError({
      message: 'rate limited',
      options: { statusCode: 429 },
    });
    expect(error.retryable).toBe(true);
  });

  it('keeps other 4xx responses non-retryable by default', () => {
    const error = new APIStatusError({
      message: 'not found',
      options: { statusCode: 404 },
    });
    expect(error.retryable).toBe(false);
  });

  it('respects explicit retryable override', () => {
    const forceRetryable = new APIStatusError({
      message: 'force retry',
      options: { statusCode: 404, retryable: true },
    });
    const forceNonRetryable = new APIStatusError({
      message: 'force no retry',
      options: { statusCode: 429, retryable: false },
    });

    expect(forceRetryable.retryable).toBe(true);
    expect(forceNonRetryable.retryable).toBe(false);
  });
});
