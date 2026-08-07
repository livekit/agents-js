// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { extractQuotaUsage } from './utils.js';

describe('extractQuotaUsage', () => {
  it('returns all stamped dimensions', () => {
    const headers = new Headers({
      'X-LiveKit-Inference-RPM-Limit': '100',
      'X-LiveKit-Inference-RPM-Used': '101',
      'X-LiveKit-Inference-TPM-Limit': '50000',
      'X-LiveKit-Inference-TPM-Used': '48000',
      'X-LiveKit-Inference-Credits-Limit': '1000000',
      'X-LiveKit-Inference-Credits-Used': '999999',
    });

    expect(extractQuotaUsage(headers)).toEqual({
      rpmLimit: '100',
      rpmUsed: '101',
      tpmLimit: '50000',
      tpmUsed: '48000',
      creditsLimit: '1000000',
      creditsUsed: '999999',
    });
  });

  it('omits missing dimensions', () => {
    const headers = new Headers({
      'X-LiveKit-Inference-RPM-Limit': '100',
      'X-LiveKit-Inference-RPM-Used': '101',
    });

    expect(extractQuotaUsage(headers)).toEqual({ rpmLimit: '100', rpmUsed: '101' });
  });

  it('returns an empty object without quota headers', () => {
    expect(extractQuotaUsage(new Headers())).toEqual({});
    expect(extractQuotaUsage(new Headers({ 'Content-Type': 'application/json' }))).toEqual({});
  });

  it('looks up headers case-insensitively', () => {
    const headers = new Headers({
      'x-livekit-inference-rpm-limit': '100',
      'x-livekit-inference-rpm-used': '42',
    });

    expect(extractQuotaUsage(headers)).toEqual({ rpmLimit: '100', rpmUsed: '42' });
  });
});
