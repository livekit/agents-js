// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createRequestSignal } from './utils.js';

describe('AWS request signals', () => {
  it('aborts and records when the request timeout elapses', async () => {
    const request = createRequestSignal(new AbortController().signal, 5);

    await new Promise<void>((resolve) => {
      request.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    expect(request.didTimeout()).toBe(true);
    expect(request.signal.reason).toMatchObject({ name: 'TimeoutError' });
    request.dispose();
  });
});
