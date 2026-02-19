// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { FRAME_DURATION_IN_S, MIN_INTERRUPTION_DURATION_IN_S } from './defaults.js';

/**
 * A bounded cache that automatically evicts the oldest entries when the cache exceeds max size.
 * Uses FIFO eviction strategy.
 */
export class BoundedCache<K, V extends object> {
  private cache: Map<K, V> = new Map();
  private readonly maxLen: number;

  constructor(maxLen: number = 10) {
    this.maxLen = maxLen;
  }

  set(key: K, value: V): void {
    this.cache.set(key, value);
    if (this.cache.size > this.maxLen) {
      // Remove the oldest entry (first inserted)
      const firstKey = this.cache.keys().next().value as K;
      this.cache.delete(firstKey);
    }
  }

  /**
   * Update existing value fields if present and defined.
   * Mirrors python BoundedDict.update_value behavior.
   */
  updateValue(key: K, fields: Partial<V>): V | undefined {
    const value = this.cache.get(key);
    if (!value) return value;

    for (const [fieldName, fieldValue] of Object.entries(fields) as [keyof V, V[keyof V]][]) {
      if (fieldValue === undefined) continue;
      // Runtime field update parity with python's hasattr + setattr.
      if (fieldName in (value as object)) {
        (value as Record<string, unknown>)[String(fieldName)] = fieldValue;
      }
    }
    return value;
  }

  /**
   * Set a new value with factory when missing; otherwise update in place.
   * Mirrors python BoundedDict.set_or_update behavior.
   */
  setOrUpdate(key: K, factory: () => V, fields: Partial<V>): V {
    if (!this.cache.has(key)) {
      this.set(key, factory());
    }
    const result = this.updateValue(key, fields);
    if (!result) {
      throw new Error('setOrUpdate invariant failed: entry should exist after set');
    }
    return result;
  }

  get(key: K): V | undefined {
    return this.cache.get(key);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Pop the last entry that matches the predicate, or return undefined.
   * Only removes and returns the matching entry, preserving others.
   */
  pop(predicate?: (value: V) => boolean): V | undefined {
    if (predicate === undefined) {
      // Pop the last (most recent) entry
      const keys = Array.from(this.cache.keys());
      if (keys.length === 0) return undefined;
      const lastKey = keys[keys.length - 1]!;
      const value = this.cache.get(lastKey);
      this.cache.delete(lastKey);
      return value;
    }

    // Find the last entry matching the predicate (iterating in reverse)
    const keys = Array.from(this.cache.keys());
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      const value = this.cache.get(key)!;
      if (predicate(value)) {
        this.cache.delete(key);
        return value;
      }
    }
    return undefined;
  }

  /**
   * Pop a key/value pair if it satisfies the predicate.
   * Mirrors python BoundedDict.pop_if behavior.
   */
  popIf(predicate?: (value: V) => boolean): [K | undefined, V | undefined] {
    if (predicate === undefined) {
      const first = this.cache.entries().next().value as [K, V] | undefined;
      if (!first) return [undefined, undefined];
      const [key, value] = first;
      this.cache.delete(key);
      return [key, value];
    }

    const keys = Array.from(this.cache.keys());
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      const value = this.cache.get(key)!;
      if (predicate(value)) {
        this.cache.delete(key);
        return [key, value];
      }
    }
    return [undefined, undefined];
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  values(): IterableIterator<V> {
    return this.cache.values();
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }
}

/**
 * Estimate probability by finding the n-th maximum value in the probabilities array.
 * The n-th position is determined by the window size (25ms per frame).
 * Returns 0 if there are insufficient probabilities.
 */
export function estimateProbability(
  probabilities: number[],
  windowSizeInS: number = MIN_INTERRUPTION_DURATION_IN_S,
): number {
  const nTh = Math.ceil(windowSizeInS / FRAME_DURATION_IN_S);
  if (probabilities.length < nTh) {
    return 0;
  }

  // Find the n-th maximum value by sorting in descending order
  // Create a copy to avoid mutating the original array
  const sorted = [...probabilities].sort((a, b) => b - a);
  return sorted[nTh - 1]!;
}
