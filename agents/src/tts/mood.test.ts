// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { DEFAULT_MOOD, MOOD_KEYWORDS, MOOD_PRIORITY, matchMood } from './_mood.js';
import { expressionAttribute, splitAllMarkup } from './_provider_format.js';

describe('mood normalization', () => {
  it('prioritizes every mood exactly once', () => {
    expect(new Set(MOOD_PRIORITY)).toEqual(new Set(Object.keys(MOOD_KEYWORDS)));
    expect(MOOD_PRIORITY).toHaveLength(new Set(MOOD_PRIORITY).size);
  });
  it.each([
    ['excited', 'excited'],
    ['soft, with genuine care', 'empathetic'],
    ['bright, upbeat energy', 'excited'],
    ['gently curious, welcoming', 'curious'],
    ['furious', 'angry'],
    ['Excited!!!', 'excited'],
  ] as const)('matches %s as %s', (label, expected) => expect(matchMood(label)).toBe(expected));
  it.each(['like a pirate', 'across the room', '', '   '])('falls back for %s', (label) => {
    expect(matchMood(label)).toBe(DEFAULT_MOOD);
    expect(matchMood(label, null)).toBeNull();
  });
  it('matches keywords only at word starts', () => {
    expect(matchMood('irate', null)).toBe('angry');
    expect(matchMood('pirate', null)).toBeNull();
    expect(matchMood('excited', null)).toBe('excited');
    expect(matchMood('unexcited', null)).toBeNull();
  });
  it.each([
    ['soft, with genuine care', 'empathetic'],
    ['like a pirate', DEFAULT_MOOD],
  ] as const)('carries expression %s and mood %s', (label, mood) => {
    const [, tags] = splitAllMarkup(`<expr type="expression" label="${label}"/>hey`);
    const attr = expressionAttribute(tags);
    expect(JSON.parse(attr!['lk.expression']!)).toEqual({ expression: label, mood });
  });
});
