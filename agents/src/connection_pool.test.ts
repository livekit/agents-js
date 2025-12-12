// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ConnectionPool } from './connection_pool.js';

describe('ConnectionPool', () => {
  const makeConnectCb = () => {
    let n = 0;
    return vi.fn(async (_timeout: number): Promise<string> => `conn_${++n}`);
  };

  describe('basic operations', () => {
    it('should create and return a connection', async () => {
      const connections: string[] = [];
      const connectCb = vi.fn(async (_timeout: number): Promise<string> => {
        const conn = `conn_${connections.length}`;
        connections.push(conn);
        return conn;
      });
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      const conn = await pool.get();
      expect(conn).toBe('conn_0');
      expect(connectCb).toHaveBeenCalledTimes(1);

      pool.put(conn);
      const conn2 = await pool.get();
      expect(conn2).toBe('conn_0'); // Should reuse
      expect(connectCb).toHaveBeenCalledTimes(1);
    });

    it('should create new connection when none available', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      const conn1 = await pool.get();
      pool.put(conn1);
      const conn2 = await pool.get();
      expect(conn1).toBe(conn2); // Should reuse
      expect(connectCb).toHaveBeenCalledTimes(1);
    });

    it('should remove connection from pool', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      const conn = await pool.get();
      pool.put(conn);
      pool.remove(conn);

      const conn2 = await pool.get();
      expect(conn2).not.toBe(conn); // Should create new connection
      expect(connectCb).toHaveBeenCalledTimes(2);
      expect(closeCb).toHaveBeenCalledTimes(1);
    });
  });

  describe('maxSessionDuration', () => {
    it('should expire connections after maxSessionDuration', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
        maxSessionDuration: 100, // 100ms
      });

      const conn1 = await pool.get();
      pool.put(conn1);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      const conn2 = await pool.get();
      expect(conn2).not.toBe(conn1); // Should create new connection
      expect(connectCb).toHaveBeenCalledTimes(2);
      expect(closeCb).toHaveBeenCalledTimes(1);
    });

    it('should refresh connection timestamp when markRefreshedOnGet is true', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
        maxSessionDuration: 200, // 200ms
        markRefreshedOnGet: true,
      });

      const conn1 = await pool.get();
      pool.put(conn1);

      // Wait 100ms (less than expiration)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Get again - should refresh timestamp
      const conn2 = await pool.get();
      expect(conn2).toBe(conn1); // Should reuse
      pool.put(conn2);

      // Wait another 100ms (total 200ms, but refreshed at 100ms)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still be valid
      const conn3 = await pool.get();
      expect(conn3).toBe(conn1); // Should still reuse
      expect(connectCb).toHaveBeenCalledTimes(1);
    });
  });

  describe('withConnection', () => {
    it('should return connection to pool on success', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      let capturedConn: string | undefined;
      await pool.withConnection(async (conn) => {
        capturedConn = conn;
        return 'result';
      });

      // Connection should be returned to pool
      const conn2 = await pool.get();
      expect(conn2).toBe(capturedConn); // Should reuse
      expect(connectCb).toHaveBeenCalledTimes(1);
    });

    it('should remove connection from pool on error', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      let capturedConn: string | undefined;
      try {
        await pool.withConnection(async (conn) => {
          capturedConn = conn;
          throw new Error('test error');
        });
      } catch (e) {
        // Expected
      }

      // Connection should be removed from pool
      const conn2 = await pool.get();
      expect(conn2).not.toBe(capturedConn); // Should create new connection
      expect(connectCb).toHaveBeenCalledTimes(2);
      expect(closeCb).toHaveBeenCalledTimes(1);
    });

    it('should handle abort signal', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      const abortController = new AbortController();
      let capturedConn: string | undefined;

      const promise = pool.withConnection(
        async (conn) => {
          capturedConn = conn;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return 'result';
        },
        { signal: abortController.signal },
      );

      // Abort after a short delay
      setTimeout(() => abortController.abort(), 10);

      await expect(promise).rejects.toThrow();

      // Connection should be removed from pool
      const conn2 = await pool.get();
      expect(conn2).not.toBe(capturedConn); // Should create new connection
      expect(closeCb).toHaveBeenCalledTimes(1);
    });
  });

  describe('prewarm', () => {
    it('should create connection in background', async () => {
      let n = 0;
      const connectCb = vi.fn(async (_timeout: number): Promise<string> => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return `conn_${++n}`;
      });
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      pool.prewarm();

      // Wait for prewarm to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      const conn = await pool.get();
      expect(conn).toBeDefined();
      expect(connectCb).toHaveBeenCalledTimes(1);
    });

    it('should not prewarm if connections already exist', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      // Create a connection first
      const conn1 = await pool.get();
      pool.put(conn1);

      pool.prewarm(); // Should not create new connection

      const conn2 = await pool.get();
      expect(conn2).toBe(conn1); // Should reuse existing
      expect(connectCb).toHaveBeenCalledTimes(1);
    });
  });

  describe('close', () => {
    it('should close all connections', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      // Create two distinct connections by checking out both before returning either.
      const conn1 = await pool.get();
      const conn2 = await pool.get();
      pool.put(conn1);
      pool.put(conn2);

      await pool.close();

      expect(closeCb).toHaveBeenCalledTimes(2);
    });

    it('should invalidate all connections', async () => {
      const connectCb = makeConnectCb();
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      // Create two distinct connections by checking out both before returning either.
      const conn1 = await pool.get();
      const conn2 = await pool.get();
      pool.put(conn1);
      pool.put(conn2);

      pool.invalidate();
      await pool.close(); // Drain to close

      expect(closeCb).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent access', () => {
    it('should handle concurrent get requests', async () => {
      const connectCb = vi.fn(async (_timeout: number): Promise<string> => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return `conn_${Date.now()}_${Math.random()}`;
      });
      const closeCb = vi.fn(async (_conn: string) => {
        // Mock close
      });

      const pool = new ConnectionPool<string>({
        connectCb,
        closeCb,
      });

      const promises = Array.from({ length: 5 }, () => pool.get());
      const connections = await Promise.all(promises);

      // All should be different connections
      const uniqueConnections = new Set(connections);
      expect(uniqueConnections.size).toBe(5);
      expect(connectCb).toHaveBeenCalledTimes(5);
    });
  });
});
