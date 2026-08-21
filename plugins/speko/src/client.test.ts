// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Speko } from '@spekoai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpekoClient } from './client.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createSpekoClient', () => {
  it('uses a provided SDK client', () => {
    const client = {} as Speko;

    expect(createSpekoClient({ client })).toBe(client);
  });

  it('requires an API key when no SDK client is provided', () => {
    vi.stubEnv('SPEKO_API_KEY', '');

    expect(() => createSpekoClient({})).toThrow(/Speko API key is required/);
  });
});
