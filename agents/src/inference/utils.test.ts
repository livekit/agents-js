// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { slidingWindowMinMax } from './utils.js';

describe('slidingWindowMinMax', () => {
  it('returns -Infinity when array is shorter than window size', () => {
    expect(slidingWindowMinMax([0.5, 0.6], 3)).toBe(-Infinity);
    expect(slidingWindowMinMax([], 1)).toBe(-Infinity);
  });

  it('returns the max value when window size is 1', () => {
    // With window size 1, min of each window is the element itself,
    // so max of mins is just the max of the array
    expect(slidingWindowMinMax([0.1, 0.5, 0.3, 0.8, 0.2], 1)).toBe(0.8);
  });

  it('finds the best sustained probability across windows', () => {
    // Windows of size 3: [0.2, 0.8, 0.7], [0.8, 0.7, 0.3], [0.7, 0.3, 0.9]
    // Mins:              0.2,             0.3,             0.3
    // Max of mins: 0.3
    expect(slidingWindowMinMax([0.2, 0.8, 0.7, 0.3, 0.9], 3)).toBe(0.3);
  });

  it('returns the single element when array length equals window size', () => {
    // Only one window covering the entire array, return min of that window
    expect(slidingWindowMinMax([0.5, 0.9, 0.7], 3)).toBe(0.5);
    expect(slidingWindowMinMax([0.8], 1)).toBe(0.8);
  });
});
