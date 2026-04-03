// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Ref: python livekit-agents/livekit/agents/utils/aio/channel.py - 1-179 lines
// Based on asyncio.Queue, see https://github.com/python/cpython/blob/main/Lib/asyncio/queues.py

/**
 * Exception thrown when an operation is attempted on a closed channel.
 */
export class ChanClosed extends Error {
  constructor() {
    super('channel closed');
    this.name = 'ChanClosed';
  }
}

/**
 * Exception thrown when a non-blocking send is attempted on a full channel.
 */
export class ChanFull extends Error {
  constructor() {
    super('channel full');
    this.name = 'ChanFull';
  }
}

/**
 * Exception thrown when a non-blocking receive is attempted on an empty channel.
 */
export class ChanEmpty extends Error {
  constructor() {
    super('channel empty');
    this.name = 'ChanEmpty';
  }
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

/**
 * An async channel (queue) modeled after Python's `aio.Chan[T]`.
 *
 * Supports:
 * - Blocking and non-blocking send/recv
 * - Backpressure via maxsize
 * - Clean close semantics (wakes all waiters, drains remaining items)
 * - Async iteration via `for await...of` (terminates on close)
 * - Optional AbortSignal integration for iteration
 *
 * @example
 * ```ts
 * const ch = new Chan<string>();
 * ch.sendNowait('hello');
 * ch.sendNowait('world');
 * ch.close();
 *
 * for await (const msg of ch) {
 *   console.log(msg); // 'hello', 'world'
 * }
 * ```
 */
export class Chan<T> implements AsyncIterable<T> {
  private _closed = false;
  private _queue: T[] = [];
  private _gets: Waiter<undefined>[] = [];
  private _puts: Waiter<undefined>[] = [];
  private readonly _maxsize: number;

  constructor(maxsize: number = 0) {
    this._maxsize = Math.max(maxsize, 0);
  }

  private _wakeupNext(waiters: Waiter<undefined>[]): void {
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (!waiter.settled) {
        waiter.settled = true;
        waiter.resolve(undefined);
        return;
      }
    }
  }

  /**
   * Send a value into the channel, blocking if the channel is full.
   * Throws {@link ChanClosed} if the channel is closed.
   */
  async send(value: T): Promise<void> {
    while (this.full() && !this._closed) {
      const waiter = this._createWaiter();
      this._puts.push(waiter);
      try {
        await waiter.promise;
      } catch (e) {
        if (e instanceof ChanClosed) throw e;
        this._removeWaiter(waiter, this._puts);
        if (!this.full() && !waiter.settled) {
          this._wakeupNext(this._puts);
        }
        throw e;
      }
    }
    this.sendNowait(value);
  }

  /**
   * Send a value into the channel without blocking.
   * Throws {@link ChanClosed} if the channel is closed.
   * Throws {@link ChanFull} if the channel buffer is full.
   */
  sendNowait(value: T): void {
    if (this._closed) {
      throw new ChanClosed();
    }
    if (this.full()) {
      throw new ChanFull();
    }
    this._queue.push(value);
    this._wakeupNext(this._gets);
  }

  /**
   * Receive a value from the channel, blocking if the channel is empty.
   * Throws {@link ChanClosed} if the channel is closed and empty.
   */
  async recv(): Promise<T> {
    while (this.empty() && !this._closed) {
      const waiter = this._createWaiter();
      this._gets.push(waiter);
      try {
        await waiter.promise;
      } catch (e) {
        if (e instanceof ChanClosed) throw e;
        this._removeWaiter(waiter, this._gets);
        if (!this.empty() && !waiter.settled) {
          this._wakeupNext(this._gets);
        }
        throw e;
      }
    }
    return this.recvNowait();
  }

  /**
   * Receive a value from the channel without blocking.
   * Throws {@link ChanClosed} if the channel is closed and empty.
   * Throws {@link ChanEmpty} if the channel is empty but not closed.
   */
  recvNowait(): T {
    if (this.empty()) {
      if (this._closed) {
        throw new ChanClosed();
      }
      throw new ChanEmpty();
    }
    const item = this._queue.shift()!;
    this._wakeupNext(this._puts);
    return item;
  }

  /**
   * Close the channel. All blocked senders receive {@link ChanClosed}.
   * Blocked receivers that can't be satisfied from the remaining buffer also receive {@link ChanClosed}.
   * Remaining buffered items can still be drained via recv/recvNowait/iteration.
   */
  close(): void {
    if (this._closed) return;
    this._closed = true;

    // Wake all putters with ChanClosed
    for (const putter of this._puts) {
      if (!putter.settled) {
        putter.settled = true;
        putter.reject(new ChanClosed());
      }
    }
    this._puts.length = 0;

    // For getters: wake those that can be satisfied from the buffer,
    // reject the rest with ChanClosed
    while (this._gets.length > this.qsize()) {
      const getter = this._gets.pop()!;
      if (!getter.settled) {
        getter.settled = true;
        getter.reject(new ChanClosed());
      }
    }

    // Wake remaining getters (they'll read from the buffer)
    while (this._gets.length > 0) {
      this._wakeupNext(this._gets);
    }
  }

  /** Whether the channel has been closed. */
  get closed(): boolean {
    return this._closed;
  }

  /** The number of items currently buffered in the channel. */
  qsize(): number {
    return this._queue.length;
  }

  /**
   * Whether the channel buffer is full.
   * An unbounded channel (maxsize=0) is never full.
   */
  full(): boolean {
    if (this._maxsize <= 0) return false;
    return this._queue.length >= this._maxsize;
  }

  /** Whether the channel buffer is empty. */
  empty(): boolean {
    return this._queue.length === 0;
  }

  /**
   * Iterate over the channel's values. The iterator terminates when the
   * channel is closed and all buffered items have been consumed.
   *
   * @param signal - Optional AbortSignal to stop iteration early.
   */
  async *iter(signal?: AbortSignal): AsyncGenerator<T, void, undefined> {
    while (true) {
      if (signal?.aborted) return;
      try {
        // If an AbortSignal is provided, race recv() against the signal
        if (signal) {
          const value = await this._recvWithSignal(signal);
          yield value;
        } else {
          yield await this.recv();
        }
      } catch (e) {
        if (e instanceof ChanClosed) return;
        // Treat abort errors as a clean stop (not an exception to propagate)
        if (signal?.aborted) return;
        throw e;
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.iter();
  }

  /**
   * Race a recv() against an AbortSignal. If the signal fires first,
   * return without yielding (the caller should check and exit).
   */
  private _recvWithSignal(signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Check if already aborted
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }

      // Try non-blocking recv first
      if (!this.empty()) {
        resolve(this.recvNowait());
        return;
      }

      if (this._closed) {
        reject(new ChanClosed());
        return;
      }

      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        // Remove the waiter we added
        const idx = this._gets.findIndex((w) => w.resolve === onWake);
        if (idx !== -1) {
          this._gets[idx]!.settled = true;
          this._gets.splice(idx, 1);
        }
        reject(signal.reason ?? new Error('aborted'));
      };

      const onWake = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        // Now try to read from the buffer
        try {
          resolve(this.recvNowait());
        } catch (e) {
          reject(e);
        }
      };

      const onReject = (err: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      };

      signal.addEventListener('abort', onAbort, { once: true });

      const waiter: Waiter<undefined> = {
        resolve: onWake,
        reject: onReject,
        settled: false,
      };
      this._gets.push(waiter);
    });
  }

  private _createWaiter(): Waiter<undefined> & { promise: Promise<undefined> } {
    let resolve: (value: undefined) => void;
    let reject: (err: Error) => void;
    const promise = new Promise<undefined>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { resolve: resolve!, reject: reject!, settled: false, promise };
  }

  private _removeWaiter(waiter: Waiter<undefined>, waiters: Waiter<undefined>[]): void {
    const idx = waiters.indexOf(waiter);
    if (idx !== -1) {
      waiters.splice(idx, 1);
    }
  }
}
