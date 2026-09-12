// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { ErrorType, SynthesiaError } from './errors.js';

describe('Synthesia errors', () => {
  const nonRetryable = [
    ErrorType.AUTH,
    ErrorType.FEATURE_NOT_IN_PLAN,
    ErrorType.UNKNOWN_AVATAR,
    ErrorType.QUOTA_EXCEEDED,
    ErrorType.INVALID_ROOM_TOKEN,
    ErrorType.LIVEKIT_CREDENTIALS_REJECTED,
    ErrorType.INVALID_SESSION_REQUEST,
  ];
  const retryable = [
    ErrorType.RATE_LIMITED,
    ErrorType.CONCURRENCY_LIMIT,
    ErrorType.TIMEOUT,
    ErrorType.CONNECTION,
  ];

  it('extends APIError and defaults untyped errors to non-retryable', () => {
    const error = new SynthesiaError('boom');
    expect(error).toBeInstanceOf(APIError);
    expect(error).toMatchObject({ type: null, retryable: false, retryAfter: null });
  });

  it.each(nonRetryable)('defaults %s to non-retryable', (type) => {
    expect(new SynthesiaError('boom', { type }).retryable).toBe(false);
  });

  it.each(retryable)('defaults %s to retryable', (type) => {
    expect(new SynthesiaError('boom', { type }).retryable).toBe(true);
  });

  it('allows retryability overrides and carries metadata', () => {
    expect(new SynthesiaError('boom', { type: ErrorType.AUTH, retryable: true }).retryable).toBe(
      true,
    );
    expect(
      new SynthesiaError('boom', { type: ErrorType.CONNECTION, retryable: false }).retryable,
    ).toBe(false);
    expect(
      new SynthesiaError('throttled', {
        type: ErrorType.RATE_LIMITED,
        retryAfter: 12_500,
        status: 429,
        requestId: 'req_1',
      }),
    ).toMatchObject({ retryAfter: 12_500, status: 429, requestId: 'req_1' });
  });

  it('safely stringifies non-string messages', () => {
    expect(new SynthesiaError({ context: ['boom'] }).message).toContain('boom');
  });
});
