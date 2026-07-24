// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { defineAgent, isAgent } from './generator.js';

describe('generator', () => {
  it('marks definitions created with defineAgent as agents', () => {
    const agent = defineAgent({
      entry: async () => {},
    });

    expect(isAgent(agent)).toBe(true);
  });

  it('does not treat unmarked structural objects as agents', () => {
    expect(isAgent({ entry: async () => {} })).toBe(false);
  });
});
