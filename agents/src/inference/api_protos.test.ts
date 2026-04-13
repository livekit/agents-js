// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { sttServerEventSchema } from './api_protos.js';

describe('sttServerEventSchema', () => {
  it('accepts numeric error codes from STT server events', () => {
    const result = sttServerEventSchema.safeParse({
      type: 'error',
      message: 'rate limited',
      code: 429,
    });

    expect(result.success).toBe(true);
  });
});
