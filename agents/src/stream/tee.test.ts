// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { Chan } from './chan.js';
import { Tee, tee } from './tee.js';

/** Helper: create an async iterable from an array */
async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/** Helper: collect all values from an async iterable */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
  }
  return results;
}

describe('tee', () => {
  // ─── Basic functionality ───

  it('should tee an async iterable into 2 copies by default', async () => {
    const source = fromArray([1, 2, 3]);
    const [a, b] = tee(source);

    const resultsA = await collect(a);
    const resultsB = await collect(b);

    expect(resultsA).toEqual([1, 2, 3]);
    expect(resultsB).toEqual([1, 2, 3]);
  });

  it('should tee into N copies', async () => {
    const source = fromArray(['x', 'y', 'z']);
    const t = tee(source, 4);

    expect(t.length).toBe(4);

    const results = await Promise.all(t.toArray().map(collect));
    for (const r of results) {
      expect(r).toEqual(['x', 'y', 'z']);
    }
  });

  it('should tee into 1 copy', async () => {
    const source = fromArray([10, 20]);
    const t = tee(source, 1);

    expect(t.length).toBe(1);
    expect(await collect(t.get(0))).toEqual([10, 20]);
  });

  it('should handle empty source', async () => {
    const source = fromArray<number>([]);
    const [a, b] = tee(source);

    expect(await collect(a)).toEqual([]);
    expect(await collect(b)).toEqual([]);
  });

  // ─── Ordering and interleaving ───

  it('should yield values in order when consumers read at different rates', async () => {
    const source = fromArray([1, 2, 3, 4, 5]);
    const [a, b] = tee(source);

    // Read from A first, then B
    const resultsA = await collect(a);
    const resultsB = await collect(b);

    expect(resultsA).toEqual([1, 2, 3, 4, 5]);
    expect(resultsB).toEqual([1, 2, 3, 4, 5]);
  });

  it('should support interleaved reads between peers', async () => {
    const source = fromArray([1, 2, 3]);
    const [a, b] = tee(source);

    const iterA = a[Symbol.asyncIterator]();
    const iterB = b[Symbol.asyncIterator]();

    // Interleave reads
    expect((await iterA.next()).value).toBe(1);
    expect((await iterB.next()).value).toBe(1);
    expect((await iterA.next()).value).toBe(2);
    expect((await iterA.next()).value).toBe(3);
    expect((await iterB.next()).value).toBe(2);
    expect((await iterB.next()).value).toBe(3);

    expect((await iterA.next()).done).toBe(true);
    expect((await iterB.next()).done).toBe(true);
  });

  // ─── Chan as source ───

  it('should work with Chan as source', async () => {
    const ch = new Chan<number>();
    const [a, b] = tee(ch);

    const resultsA: number[] = [];
    const resultsB: number[] = [];

    const consumerA = (async () => {
      for await (const v of a) resultsA.push(v);
    })();
    const consumerB = (async () => {
      for await (const v of b) resultsB.push(v);
    })();

    ch.sendNowait(10);
    ch.sendNowait(20);
    ch.sendNowait(30);
    ch.close();

    await Promise.all([consumerA, consumerB]);

    expect(resultsA).toEqual([10, 20, 30]);
    expect(resultsB).toEqual([10, 20, 30]);
  });

  it('should work with Chan and concurrent producer', async () => {
    const ch = new Chan<number>();
    const [a, b] = tee(ch);

    const resultsA: number[] = [];
    const resultsB: number[] = [];

    const consumerA = (async () => {
      for await (const v of a) resultsA.push(v);
    })();
    const consumerB = (async () => {
      for await (const v of b) resultsB.push(v);
    })();

    const producer = (async () => {
      for (let i = 0; i < 10; i++) {
        await ch.send(i);
        await new Promise((r) => setTimeout(r, 1));
      }
      ch.close();
    })();

    await Promise.all([producer, consumerA, consumerB]);

    expect(resultsA).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(resultsB).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  // ─── Error propagation ───

  it('should propagate errors from source to all peers', async () => {
    const error = new Error('upstream failure');
    async function* failingSource(): AsyncGenerator<number> {
      yield 1;
      yield 2;
      throw error;
    }

    const [a, b] = tee(failingSource());

    const iterA = a[Symbol.asyncIterator]();
    const iterB = b[Symbol.asyncIterator]();

    // Both peers get the first two values
    expect((await iterA.next()).value).toBe(1);
    expect((await iterB.next()).value).toBe(1);
    expect((await iterA.next()).value).toBe(2);
    expect((await iterB.next()).value).toBe(2);

    // Both peers should see the error
    await expect(iterA.next()).rejects.toThrow('upstream failure');
    await expect(iterB.next()).rejects.toThrow('upstream failure');
  });

  it('should propagate errors to peers that have not yet reached the error', async () => {
    const error = new Error('boom');
    async function* failingSource(): AsyncGenerator<number> {
      yield 1;
      throw error;
    }

    const [a, b] = tee(failingSource());

    // A reads ahead and hits the error
    const iterA = a[Symbol.asyncIterator]();
    expect((await iterA.next()).value).toBe(1);
    await expect(iterA.next()).rejects.toThrow('boom');

    // B should also see the error after consuming buffered items
    const iterB = b[Symbol.asyncIterator]();
    expect((await iterB.next()).value).toBe(1);
    await expect(iterB.next()).rejects.toThrow('boom');
  });

  // ─── Partial consumption ───

  it('should handle one peer consuming all while another consumes partially', async () => {
    const source = fromArray([1, 2, 3, 4, 5]);
    const [a, b] = tee(source);

    // A reads everything
    const resultsA = await collect(a);
    expect(resultsA).toEqual([1, 2, 3, 4, 5]);

    // B only reads 2 items then stops
    const iterB = b[Symbol.asyncIterator]();
    expect((await iterB.next()).value).toBe(1);
    expect((await iterB.next()).value).toBe(2);
    // Abandon B — should not hang or leak
    await iterB.return!(undefined);
  });

  it('should close upstream when last peer is closed', async () => {
    let upstreamClosed = false;
    async function* tracked(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
        yield 3;
      } finally {
        upstreamClosed = true;
      }
    }

    const t = tee(tracked(), 2);
    const [a, b] = t.toArray();

    // Close both peers
    await a.return(undefined);
    expect(upstreamClosed).toBe(false); // Still one peer left
    await b.return(undefined);
    expect(upstreamClosed).toBe(true); // Last peer closed upstream
  });

  // ─── aclose ───

  it('should close all children and upstream via aclose', async () => {
    let upstreamClosed = false;
    async function* tracked(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
      } finally {
        upstreamClosed = true;
      }
    }

    const t = new Tee(tracked(), 3);
    await t.aclose();
    expect(upstreamClosed).toBe(true);
  });

  // ─── Indexing and iteration ───

  it('should support get() for index access', () => {
    const source = fromArray([1]);
    const t = tee(source, 3);

    expect(t.get(0)).toBeDefined();
    expect(t.get(1)).toBeDefined();
    expect(t.get(2)).toBeDefined();
    expect(() => t.get(3)).toThrow(RangeError);
    expect(() => t.get(-1)).toThrow(RangeError);
  });

  it('should support Symbol.iterator for destructuring', () => {
    const source = fromArray([1]);
    const t = tee(source, 3);

    const children = [...t];
    expect(children.length).toBe(3);
  });

  // ─── Resource leak prevention ───

  it('should not leak buffers after all peers complete', async () => {
    const source = fromArray([1, 2, 3]);
    const t = tee(source, 3);
    const children = t.toArray();

    await Promise.all(children.map(collect));

    // Internal buffers should be cleaned up (peers array emptied)
    expect((t as any)._buffers.length).toBe(0);
  });

  it('should handle large fan-out without issues', async () => {
    const source = fromArray([1, 2, 3]);
    const t = tee(source, 20);

    const results = await Promise.all(t.toArray().map(collect));
    for (const r of results) {
      expect(r).toEqual([1, 2, 3]);
    }
  });

  it('should handle tee of tee', async () => {
    const source = fromArray([1, 2, 3]);
    const [a, b] = tee(source);

    // Tee one of the children again
    const [a1, a2] = tee(a);

    const resultsA1 = await collect(a1);
    const resultsA2 = await collect(a2);
    const resultsB = await collect(b);

    expect(resultsA1).toEqual([1, 2, 3]);
    expect(resultsA2).toEqual([1, 2, 3]);
    expect(resultsB).toEqual([1, 2, 3]);
  });
});
