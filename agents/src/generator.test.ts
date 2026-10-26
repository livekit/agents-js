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

describe('defineAgent onSimulationEnd', () => {
  it('carries the callback through the definition', () => {
    const onSimulationEnd = () => {};
    const agent = defineAgent({
      entry: async () => {},
      onSimulationEnd,
    });
    expect(isAgent(agent)).toBe(true);
    expect(agent.onSimulationEnd).toBe(onSimulationEnd);
  });
});

describe('defineAgent onSessionEnd', () => {
  it('carries the callback through the definition', () => {
    const onSessionEnd = () => {};
    const agent = defineAgent({
      entry: async () => {},
      onSessionEnd,
    });
    expect(isAgent(agent)).toBe(true);
    expect(agent.onSessionEnd).toBe(onSessionEnd);
  });
});
