import { FRAME_DURATION_IN_S, MIN_INTERRUPTION_DURATION_IN_S } from './defaults.js';

/**
 * A bounded cache that automatically evicts the oldest entries when the cache exceeds max size.
 * Uses FIFO eviction strategy.
 */
export class BoundedCache<K, V> {
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
   * Get existing entry and update it, or create a new one using factory.
   * Updates the entry with the provided partial fields.
   */
  setOrUpdate<T extends V>(
    key: K,
    factory: () => T,
    updates: Partial<{ [P in keyof T]: T[P] }>,
  ): T {
    let entry = this.cache.get(key) as T | undefined;
    if (entry === undefined) {
      entry = factory();
      this.set(key, entry);
    }
    // Apply updates to the entry
    for (const [field, value] of Object.entries(updates)) {
      if (value !== undefined) {
        (entry as Record<string, unknown>)[field] = value;
      }
    }
    return entry;
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
 * Estimate probability using sliding window min-max algorithm.
 * Returns a conservative estimate based on the minimum window size.
 */
export function estimateProbability(
  probabilities: number[],
  windowSizeInS: number = MIN_INTERRUPTION_DURATION_IN_S,
): number {
  const minWindow = Math.ceil(windowSizeInS / FRAME_DURATION_IN_S);
  if (probabilities.length < minWindow) {
    return 0;
  }

  return slidingWindowMinMax(probabilities, minWindow);
}

export function slidingWindowMinMax(probabilities: number[], minWindow: number): number {
  if (probabilities.length < minWindow) {
    return -Infinity;
  }

  let maxOfMins = -Infinity;

  for (let i = 0; i <= probabilities.length - minWindow; i++) {
    const windowMin = Math.min(...probabilities.slice(i, i + minWindow));
    maxOfMins = Math.max(maxOfMins, windowMin);
  }

  return maxOfMins;
}
