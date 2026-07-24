// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import { toError, waitForAbort } from './utils.js';

/**
 * Helper class to manage persistent connections like websockets.
 */
export interface ConnectionPoolOptions<T> {
  /**
   * Maximum duration in milliseconds before forcing reconnection.
   * If not set, connections will never expire based on duration.
   */
  maxSessionDuration?: number;

  /**
   * If true, the session will be marked as fresh when get() is called.
   * Only used when maxSessionDuration is set.
   */
  markRefreshedOnGet?: boolean;

  /**
   * Async callback to create new connections.
   * @param timeout - Connection timeout in milliseconds
   * @returns A new connection object
   */
  connectCb: (timeout: number, signal?: AbortSignal) => Promise<T>;

  /**
   * Optional callback to map connection failures to provider-specific errors.
   * The original error is passed when available.
   */
  connectionError?: (error?: Error) => Error;

  /**
   * Optional async callback to close connections.
   * @param conn - The connection to close
   */
  closeCb?: (conn: T) => Promise<void>;

  /**
   * Default connection timeout in milliseconds.
   * Defaults to 10000 (10 seconds).
   */
  connectTimeout?: number;
}

/**
 * Connection pool for managing persistent WebSocket connections.
 *
 * Reuses connections efficiently and automatically refreshes them after max duration.
 * Prevents creating too many connections in a single conversation.
 */
export class ConnectionPool<T> {
  private readonly maxSessionDuration?: number;
  private readonly markRefreshedOnGet: boolean;
  private readonly connectCb: (timeout: number, signal?: AbortSignal) => Promise<T>;
  private readonly connectionError?: (error?: Error) => Error;
  private readonly closeCb?: (conn: T) => Promise<void>;
  private readonly connectTimeout: number;

  // Track connections and their creation timestamps
  private readonly connections: Map<T, number> = new Map();
  // Available connections ready for reuse
  private readonly available: Set<T> = new Set();
  // Connections queued for closing
  private readonly toClose: Set<T> = new Set();
  private readonly pendingCloseTasks = new Set<Promise<void>>();
  // Mutex for connection operations
  private readonly connectLock = new Mutex();
  // Prewarm task reference
  private prewarmController?: AbortController;
  private prewarmTask?: Promise<void>;
  private closed = false;
  private _lastConnectionReused = false;

  constructor(options: ConnectionPoolOptions<T>) {
    this.maxSessionDuration = options.maxSessionDuration;
    this.markRefreshedOnGet = options.markRefreshedOnGet ?? false;
    this.connectCb = options.connectCb;
    this.connectionError = options.connectionError;
    this.closeCb = options.closeCb;
    this.connectTimeout = options.connectTimeout ?? 10_000;
  }

  /**
   * Create a new connection.
   *
   * @param timeout - Connection timeout in milliseconds
   * @returns The new connection object
   * @throws If connectCb is not provided or connection fails
   */
  private async _connect(timeout: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted || this.closed) {
      throw this._abortError(signal);
    }

    try {
      const connection = await this.connectCb(timeout, signal);
      if (signal?.aborted || this.closed) {
        await this._maybeCloseConnection(connection);
        throw this._abortError(signal);
      }
      this.connections.set(connection, Date.now());
      return connection;
    } catch (error) {
      if (signal?.aborted || this.closed) {
        throw this._abortError(signal);
      }
      if (this.connectionError) {
        throw this.connectionError(error instanceof Error ? error : undefined);
      }
      throw toError(error);
    }
  }

  /**
   * Whether the most recent get() returned an existing pooled connection.
   */
  get lastConnectionReused(): boolean {
    return this._lastConnectionReused;
  }

  /**
   * Drain and close all connections queued for closing.
   */
  private async _drainToClose(): Promise<void> {
    const connectionsToClose = Array.from(this.toClose);
    this.toClose.clear();

    for (const conn of connectionsToClose) {
      await this._maybeCloseConnection(conn);
    }
  }

  /**
   * Close a connection if closeCb is provided.
   *
   * @param conn - The connection to close
   */
  private async _maybeCloseConnection(conn: T): Promise<void> {
    if (this.closeCb) {
      await this.closeCb(conn);
    }
  }

  private _abortError(signal?: AbortSignal): Error {
    if (signal?.reason instanceof Error) {
      return signal.reason;
    }
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  }

  /**
   * Get an available connection or create a new one if needed.
   *
   * @param timeout - Connection timeout in milliseconds
   * @returns An active connection object
   */
  async get(timeout?: number): Promise<T> {
    return (await this.getWithMetadata(timeout)).connection;
  }

  /**
   * Get a connection together with reuse metadata from the same locked acquisition.
   */
  async getWithMetadata(
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<{ connection: T; reused: boolean }> {
    if (signal?.aborted || this.closed) {
      throw this._abortError(signal);
    }

    const unlock = await this.connectLock.lock();
    try {
      if (signal?.aborted || this.closed) {
        throw this._abortError(signal);
      }
      await this._drainToClose();
      const now = Date.now();

      // Try to reuse an available connection that hasn't expired
      while (this.available.size > 0) {
        const conn = this.available.values().next().value as T;
        this.available.delete(conn);

        if (
          this.maxSessionDuration === undefined ||
          now - (this.connections.get(conn) ?? 0) <= this.maxSessionDuration
        ) {
          if (this.markRefreshedOnGet) {
            this.connections.set(conn, now);
          }
          this._lastConnectionReused = true;
          return { connection: conn, reused: true };
        }

        // Connection expired; close it now so callers observing get() see it closed promptly.
        // (Also makes tests deterministic: closeCb should have been called by the time get() resolves.)
        if (this.connections.has(conn)) {
          this.connections.delete(conn);
        }
        this.toClose.delete(conn);
        await this._maybeCloseConnection(conn);
      }

      const conn = await this._connect(timeout ?? this.connectTimeout, signal);
      this._lastConnectionReused = false;
      return { connection: conn, reused: false };
    } finally {
      unlock();
    }
  }

  /**
   * Mark a connection as available for reuse.
   *
   * If connection has been removed, it will not be added to the pool.
   *
   * @param conn - The connection to make available
   */
  put(conn: T): void {
    if (this.connections.has(conn)) {
      this.available.add(conn);
      return;
    }
  }

  /**
   * Remove a specific connection from the pool.
   *
   * Marks the connection to be closed during the next drain cycle.
   *
   * @param conn - The connection to remove
   */
  remove(conn: T): void {
    this.available.delete(conn);
    if (this.connections.has(conn)) {
      this.toClose.add(conn);
      this.connections.delete(conn);
      // Important for Node websockets: if we just "mark to close later" but remove listeners,
      // the ws library can buffer incoming frames in memory. Close ASAP in background.
      const task = (async () => {
        const unlock = await this.connectLock.lock();
        try {
          if (!this.toClose.has(conn)) return;
          await this._maybeCloseConnection(conn);
          this.toClose.delete(conn);
        } finally {
          unlock();
        }
      })().catch(() => {
        // Removal is synchronous from the caller's perspective; close() still waits for cleanup.
      });
      this.pendingCloseTasks.add(task);
      void task.finally(() => this.pendingCloseTasks.delete(task));
    }
  }

  /**
   * Clear all existing connections.
   *
   * Marks all current connections to be closed during the next drain cycle.
   */
  invalidate(): void {
    for (const conn of this.connections.keys()) {
      this.toClose.add(conn);
    }
    this.connections.clear();
    this.available.clear();
  }

  /**
   * Initiate prewarming of the connection pool without blocking.
   *
   * This method starts a background task that creates a new connection if none exist.
   * The task automatically cleans itself up when the connection pool is closed.
   */
  prewarm(): void {
    if (this.closed || this.prewarmTask || this.connections.size > 0) {
      return;
    }

    const controller = new AbortController();
    this.prewarmController = controller;

    const task = this._prewarmImpl(controller.signal)
      .catch(() => {
        // Prewarming is best effort. A normal get() will surface provider failures.
      })
      .finally(() => {
        if (this.prewarmTask === task) {
          this.prewarmTask = undefined;
          this.prewarmController = undefined;
        }
      });
    this.prewarmTask = task;
  }

  private async _prewarmImpl(signal: AbortSignal): Promise<void> {
    const unlock = await this.connectLock.lock();
    try {
      if (signal.aborted) {
        return;
      }

      if (this.connections.size === 0) {
        const conn = await this._connect(this.connectTimeout, signal);
        this.available.add(conn);
      }
    } finally {
      unlock();
    }
  }

  /**
   * Get a connection from the pool and automatically return it when done.
   * Handles abort signals and ensures proper cleanup.
   *
   * @param fn - Function to execute with the connection
   * @param options - Options including timeout and abort signal
   * @returns The result of the function
   */
  async withConnection<R>(
    fn: (conn: T) => Promise<R>,
    options?: {
      timeout?: number;
      signal?: AbortSignal;
    },
  ): Promise<R> {
    // Check if already aborted before getting connection
    if (options?.signal?.aborted) {
      throw this._abortError();
    }

    const conn = (await this.getWithMetadata(options?.timeout, options?.signal)).connection;

    const signal = options?.signal;

    try {
      const fnPromise = fn(conn);
      const result = signal
        ? await ThrowsPromise.race([
            fnPromise.then((value) => ({ type: 'result' as const, value })),
            waitForAbort(signal).then(() => ({ type: 'abort' as const })),
          ]).then((r) => {
            if (r.type === 'abort') throw this._abortError();
            return r.value;
          })
        : await fnPromise;
      // Return connection to pool on success
      this.put(conn);
      return result;
    } catch (error) {
      // Remove connection from pool on error (don't return it)
      this.remove(conn);
      throw error;
    }
  }

  /**
   * Close all connections, draining any pending connection closures.
   */
  async close(): Promise<void> {
    this.closed = true;

    // Cancel prewarm task if running
    if (this.prewarmController) {
      this.prewarmController.abort();
    }
    if (this.prewarmTask) {
      await this.prewarmTask;
    }

    const unlock = await this.connectLock.lock();
    try {
      this.invalidate();
      await this._drainToClose();
    } finally {
      unlock();
    }
    await Promise.all(this.pendingCloseTasks);
  }
}
