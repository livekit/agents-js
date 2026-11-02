// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { BoundedCache } from './utils.js';

class Entry {
  createdAt: number;
  totalDurationInS: number | undefined = undefined;
  predictionDurationInS: number | undefined = undefined;
  note: string | undefined = undefined;

  constructor(createdAt: number, note?: string) {
    this.createdAt = createdAt;
    this.note = note;
  }
}

describe('BoundedCache', () => {
  it('evicts oldest entry when maxLen is exceeded', () => {
    const cache = new BoundedCache<number, Entry>(2);
    cache.set(1, new Entry(1));
    cache.set(2, new Entry(2));
    cache.set(3, new Entry(3));

    expect(cache.size).toBe(2);
    expect([...cache.keys()]).toEqual([2, 3]);
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)!.createdAt).toBe(2);
    expect(cache.get(3)!.createdAt).toBe(3);
  });

  it('updateValue returns undefined for missing key', () => {
    const cache = new BoundedCache<number, Entry>(10);
    const result = cache.updateValue(404, { note: 'missing' });

    expect(result).toBeUndefined();
  });

  it('updateValue ignores undefined fields', () => {
    const cache = new BoundedCache<number, Entry>(10);
    cache.set(1, new Entry(1, 'keep'));

    const result = cache.updateValue(1, {
      note: undefined,
      predictionDurationInS: 0.1,
    });

    expect(result?.createdAt).toBe(1);
    expect(result?.note).toBe('keep');
    expect(result?.predictionDurationInS).toBe(0.1);
  });

  it('pop without predicate removes the oldest entry', () => {
    const cache = new BoundedCache<number, Entry>(10);
    cache.set(1, new Entry(1));
    cache.set(2, new Entry(2));
    cache.set(3, new Entry(3));

    const popped = cache.pop();

    expect(popped?.createdAt).toBe(1);
    expect([...cache.keys()]).toEqual([2, 3]);
  });

  it('pop with predicate removes the most recent matching entry', () => {
    const cache = new BoundedCache<number, Entry>(10);
    const e1 = new Entry(1);
    e1.totalDurationInS = 0;
    const e2 = new Entry(2);
    e2.totalDurationInS = 1;
    const e3 = new Entry(3);
    e3.totalDurationInS = 2;
    cache.set(1, e1);
    cache.set(2, e2);
    cache.set(3, e3);

    const popped = cache.pop((entry) => (entry.totalDurationInS ?? 0) > 0);

    expect(popped?.createdAt).toBe(3);
    expect(popped?.totalDurationInS).toBe(2);
    expect([...cache.keys()]).toEqual([1, 2]);
  });

  it('pop with predicate returns undefined when no match exists', () => {
    const cache = new BoundedCache<number, Entry>(10);
    const e1 = new Entry(1);
    e1.totalDurationInS = 0;
    cache.set(1, e1);

    const popped = cache.pop((entry) => (entry.totalDurationInS ?? 0) > 10);

    expect(popped).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('clear removes all entries', () => {
    const cache = new BoundedCache<number, Entry>(10);
    cache.set(1, new Entry(1));
    cache.set(2, new Entry(2));

    cache.clear();

    expect(cache.size).toBe(0);
    expect([...cache.keys()]).toEqual([]);
  });
});
