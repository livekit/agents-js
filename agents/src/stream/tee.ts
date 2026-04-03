// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Ref: python livekit-agents/livekit/agents/utils/aio/itertools.py - 1-129 lines
// Based on https://github.com/maxfischer2781/asyncstdlib/blob/master/asyncstdlib/itertools.py

interface ACloseable {
  aclose(): Promise<void>;
}

function isACloseable(obj: unknown): obj is ACloseable {
  return (
    typeof obj === 'object' && obj !== null && 'aclose' in obj && typeof obj.aclose === 'function'
  );
}

async function closeIterator<T>(iterator: AsyncIterator<T>, started: boolean): Promise<void> {
  if (isACloseable(iterator)) {
    await iterator.aclose();
  } else if (
    typeof iterator === 'object' &&
    iterator !== null &&
    'return' in iterator &&
    typeof iterator.return === 'function'
  ) {
    // JS async generators skip try/finally if never advanced.
    // Start the generator so its cleanup logic can run.
    if (!started) {
      try {
        await iterator.next();
      } catch {
        // ignore — we just need it entered
      }
    }
    await iterator.return(undefined);
  }
}

/**
 * A simple async mutex lock.
 * Uses a queue of resolve callbacks to ensure FIFO ordering.
 */
class Lock {
  private _locked = false;
  private _waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return this._release.bind(this);
    }

    return new Promise<() => void>((resolve) => {
      this._waiters.push(() => {
        resolve(this._release.bind(this));
      });
    });
  }

  private _release(): void {
    if (this._waiters.length > 0) {
      const next = this._waiters.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

/**
 * A tee peer iterator implemented as a class rather than an async generator.
 * This ensures proper cleanup even when the iterator is closed before being
 * started (JS async generators skip try/finally if never advanced).
 *
 * Each peer maintains its own buffer and advances the shared upstream iterator
 * under a lock when its buffer is empty.
 *
 * Error semantics: When the upstream iterator throws, the first peer to encounter
 * the error stores it in the shared `exception` array. All other peers re-raise the
 * same exception, ensuring every consumer sees the upstream failure.
 */
class TeePeerIterator<T> implements AsyncIterableIterator<T> {
  private _buffer: T[];
  private _peers: T[][];
  private _iterator: AsyncIterator<T>;
  private _lock: Lock;
  private _exception: [Error | null];
  private _started: { value: boolean };
  private _done = false;

  constructor(
    iterator: AsyncIterator<T>,
    buffer: T[],
    peers: T[][],
    lock: Lock,
    exception: [Error | null],
    started: { value: boolean },
  ) {
    this._iterator = iterator;
    this._buffer = buffer;
    this._peers = peers;
    this._lock = lock;
    this._exception = exception;
    this._started = started;
  }

  async next(): Promise<IteratorResult<T>> {
    if (this._done) {
      return { value: undefined as unknown as T, done: true };
    }

    // If buffer has items, yield from buffer
    if (this._buffer.length > 0) {
      return { value: this._buffer.shift()!, done: false };
    }

    // Need to advance the upstream iterator under lock
    const release = await this._lock.acquire();
    try {
      // Re-check after acquiring lock — another peer may have filled our buffer
      if (this._buffer.length > 0) {
        return { value: this._buffer.shift()!, done: false };
      }

      // A peer already hit an upstream error — re-raise for this peer
      if (this._exception[0] !== null) {
        this._done = true;
        this._removeSelf();
        throw this._exception[0];
      }

      let result: IteratorResult<T>;
      try {
        result = await this._iterator.next();
        this._started.value = true;
      } catch (e) {
        this._started.value = true;
        this._exception[0] = e instanceof Error ? e : new Error(String(e));
        this._done = true;
        this._removeSelf();
        throw this._exception[0];
      }

      if (result.done) {
        this._done = true;
        this._removeSelf();
        return { value: undefined as unknown as T, done: true };
      }

      // Fan out to all peer buffers
      for (const peerBuffer of this._peers) {
        peerBuffer.push(result.value);
      }
    } finally {
      release();
    }

    return { value: this._buffer.shift()!, done: false };
  }

  async return(): Promise<IteratorResult<T>> {
    if (!this._done) {
      this._done = true;
      await this._removeSelfAsync();
    }
    return { value: undefined as unknown as T, done: true };
  }

  async throw(e: unknown): Promise<IteratorResult<T>> {
    this._done = true;
    await this._removeSelfAsync();
    throw e;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  private _removeSelf(): void {
    const idx = this._peers.indexOf(this._buffer);
    if (idx !== -1) {
      this._peers.splice(idx, 1);
    }
  }

  private async _removeSelfAsync(): Promise<void> {
    this._removeSelf();

    // If we're the last peer, close the upstream iterator
    if (this._peers.length === 0) {
      await closeIterator(this._iterator, this._started.value);
    }
  }
}

/**
 * Split a single `AsyncIterable<T>` into `n` independent async iterators.
 *
 * Each child iterator yields every item from the source. Items are buffered
 * per-peer, and the source is advanced lazily (only when a peer's buffer is
 * empty). When the last peer is closed or garbage-collected, the upstream
 * iterator is closed automatically.
 *
 * This is the JS equivalent of Python's `aio.itertools.tee(iterable, n)`.
 *
 * @example
 * ```ts
 * const source = someAsyncIterable();
 * const [a, b] = tee(source, 2);
 *
 * // Both a and b yield every item from source
 * for await (const item of a) { ... }
 * for await (const item of b) { ... }
 * ```
 */
export class Tee<T> {
  private _iterator: AsyncIterator<T>;
  private _buffers: T[][];
  private _children: TeePeerIterator<T>[];

  constructor(iterable: AsyncIterable<T>, n: number = 2) {
    this._iterator = iterable[Symbol.asyncIterator]();
    this._buffers = Array.from({ length: n }, () => []);

    const lock = new Lock();
    const exception: [Error | null] = [null];
    const started = { value: false };

    this._children = this._buffers.map(
      (buffer) =>
        new TeePeerIterator(this._iterator, buffer, this._buffers, lock, exception, started),
    );
  }

  /** The number of peer iterators. */
  get length(): number {
    return this._children.length;
  }

  /** Access a specific peer by index. */
  get(index: number): TeePeerIterator<T> {
    const child = this._children[index];
    if (!child) {
      throw new RangeError(`tee index ${index} out of range [0, ${this._children.length})`);
    }
    return child;
  }

  /** Destructure into an array of async iterators. */
  toArray(): TeePeerIterator<T>[] {
    return [...this._children];
  }

  /** Iterate over the peer iterators. */
  [Symbol.iterator](): Iterator<TeePeerIterator<T>> {
    return this._children[Symbol.iterator]();
  }

  /** Close all peer iterators and the upstream iterator. */
  async aclose(): Promise<void> {
    for (const child of this._children) {
      try {
        await child.return();
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Ensure upstream is closed even if peer cleanup didn't trigger it
    try {
      await closeIterator(this._iterator, true);
    } catch {
      // Ignore errors during cleanup
    }
  }
}

/**
 * Convenience function to tee an async iterable into `n` independent iterators.
 *
 * @returns A {@link Tee} instance that can be destructured or indexed.
 */
export function tee<T>(iterable: AsyncIterable<T>, n: number = 2): Tee<T> {
  return new Tee(iterable, n);
}
