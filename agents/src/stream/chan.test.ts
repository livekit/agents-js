// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { Chan, ChanClosed, ChanEmpty, ChanFull } from './chan.js';

describe('Chan', () => {
  // ─── Basic send/recv ───

  it('should send and receive a single value', async () => {
    const ch = new Chan<string>();
    ch.sendNowait('hello');
    const value = await ch.recv();
    expect(value).toBe('hello');
  });

  it('should send and receive multiple values in order', async () => {
    const ch = new Chan<number>();
    ch.sendNowait(1);
    ch.sendNowait(2);
    ch.sendNowait(3);

    expect(await ch.recv()).toBe(1);
    expect(await ch.recv()).toBe(2);
    expect(await ch.recv()).toBe(3);
  });

  it('should handle null and undefined values', async () => {
    const ch = new Chan<string | null | undefined>();
    ch.sendNowait('test');
    ch.sendNowait(null);
    ch.sendNowait(undefined);
    ch.sendNowait('another');

    expect(await ch.recv()).toBe('test');
    expect(await ch.recv()).toBeNull();
    expect(await ch.recv()).toBeUndefined();
    expect(await ch.recv()).toBe('another');
  });

  it('should preserve object references', async () => {
    const obj = { key: 'value' };
    const ch = new Chan<typeof obj>();
    ch.sendNowait(obj);
    const received = await ch.recv();
    expect(received).toBe(obj);
  });

  // ─── Non-blocking operations ───

  it('should throw ChanEmpty on recvNowait from empty channel', () => {
    const ch = new Chan<string>();
    expect(() => ch.recvNowait()).toThrow(ChanEmpty);
  });

  it('should throw ChanClosed on sendNowait to closed channel', () => {
    const ch = new Chan<string>();
    ch.close();
    expect(() => ch.sendNowait('test')).toThrow(ChanClosed);
  });

  it('should throw ChanClosed on recvNowait from closed empty channel', () => {
    const ch = new Chan<string>();
    ch.close();
    expect(() => ch.recvNowait()).toThrow(ChanClosed);
  });

  it('should allow recvNowait from closed channel with buffered items', () => {
    const ch = new Chan<string>();
    ch.sendNowait('buffered');
    ch.close();
    expect(ch.recvNowait()).toBe('buffered');
    expect(() => ch.recvNowait()).toThrow(ChanClosed);
  });

  // ─── Blocking send/recv ───

  it('should block recv until a value is sent', async () => {
    const ch = new Chan<string>();
    const recvPromise = ch.recv();

    // Send after a microtask delay
    await Promise.resolve();
    ch.sendNowait('delayed');

    expect(await recvPromise).toBe('delayed');
  });

  it('should handle concurrent send and recv', async () => {
    const ch = new Chan<string>();
    const results: string[] = [];

    const consumer = (async () => {
      for await (const value of ch) {
        results.push(value);
      }
    })();

    const data = ['a', 'b', 'c', 'd', 'e'];
    for (const item of data) {
      ch.sendNowait(item);
    }
    ch.close();

    await consumer;
    expect(results).toEqual(data);
  });

  it('should wake blocked recv when value is sent', async () => {
    const ch = new Chan<number>();
    let received: number | undefined;

    const recvTask = (async () => {
      received = await ch.recv();
    })();

    // Let the recv() settle into waiting
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toBeUndefined();

    ch.sendNowait(42);
    await recvTask;
    expect(received).toBe(42);
  });

  // ─── Backpressure (maxsize) ───

  it('should report full when maxsize is reached', () => {
    const ch = new Chan<number>(2);
    expect(ch.full()).toBe(false);
    ch.sendNowait(1);
    expect(ch.full()).toBe(false);
    ch.sendNowait(2);
    expect(ch.full()).toBe(true);
  });

  it('should throw ChanFull on sendNowait to full channel', () => {
    const ch = new Chan<number>(1);
    ch.sendNowait(1);
    expect(() => ch.sendNowait(2)).toThrow(ChanFull);
  });

  it('should block send on full channel until recv makes space', async () => {
    const ch = new Chan<number>(1);
    ch.sendNowait(1);

    let sendCompleted = false;
    const sendPromise = ch.send(2).then(() => {
      sendCompleted = true;
    });

    // Send should be blocked
    await new Promise((r) => setTimeout(r, 10));
    expect(sendCompleted).toBe(false);

    // Consuming one item should unblock the send
    expect(await ch.recv()).toBe(1);
    await sendPromise;
    expect(sendCompleted).toBe(true);
    expect(await ch.recv()).toBe(2);
  });

  it('should handle unbounded channel (maxsize=0) as never full', () => {
    const ch = new Chan<number>();
    for (let i = 0; i < 1000; i++) {
      ch.sendNowait(i);
    }
    expect(ch.full()).toBe(false);
    expect(ch.qsize()).toBe(1000);
  });

  it('should treat negative maxsize as unbounded', () => {
    const ch = new Chan<number>(-5);
    for (let i = 0; i < 100; i++) {
      ch.sendNowait(i);
    }
    expect(ch.full()).toBe(false);
  });

  // ─── Close semantics ───

  it('should drain buffered items after close', async () => {
    const ch = new Chan<number>();
    ch.sendNowait(1);
    ch.sendNowait(2);
    ch.sendNowait(3);
    ch.close();

    const results: number[] = [];
    for await (const value of ch) {
      results.push(value);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  it('should throw ChanClosed on send after close', async () => {
    const ch = new Chan<string>();
    ch.close();
    await expect(ch.send('test')).rejects.toThrow(ChanClosed);
  });

  it('should throw ChanClosed on recv from closed empty channel', async () => {
    const ch = new Chan<string>();
    ch.close();
    await expect(ch.recv()).rejects.toThrow(ChanClosed);
  });

  it('should handle double close without error', () => {
    const ch = new Chan<string>();
    ch.close();
    expect(() => ch.close()).not.toThrow();
    expect(ch.closed).toBe(true);
  });

  it('should wake all blocked receivers on close', async () => {
    const ch = new Chan<string>();

    const recv1 = ch.recv().catch((e) => e);
    const recv2 = ch.recv().catch((e) => e);
    const recv3 = ch.recv().catch((e) => e);

    await new Promise((r) => setTimeout(r, 10));
    ch.close();

    const [r1, r2, r3] = await Promise.all([recv1, recv2, recv3]);
    expect(r1).toBeInstanceOf(ChanClosed);
    expect(r2).toBeInstanceOf(ChanClosed);
    expect(r3).toBeInstanceOf(ChanClosed);
  });

  it('should wake blocked senders with ChanClosed on close', async () => {
    const ch = new Chan<number>(1);
    ch.sendNowait(1); // Fill the channel

    const sendResult = ch.send(2).catch((e) => e);

    await new Promise((r) => setTimeout(r, 10));
    ch.close();

    const result = await sendResult;
    expect(result).toBeInstanceOf(ChanClosed);
  });

  it('should satisfy some blocked receivers from buffer on close', async () => {
    const ch = new Chan<number>();

    // Start 3 receivers waiting
    const recv1 = ch.recv().catch((e) => (e instanceof ChanClosed ? 'closed' : 'error'));
    const recv2 = ch.recv().catch((e) => (e instanceof ChanClosed ? 'closed' : 'error'));
    const recv3 = ch.recv().catch((e) => (e instanceof ChanClosed ? 'closed' : 'error'));

    await new Promise((r) => setTimeout(r, 10));

    // Send 2 items, then close — 2 receivers get values, 1 gets ChanClosed
    ch.sendNowait(10);
    ch.sendNowait(20);
    ch.close();

    const [r1, r2, r3] = await Promise.all([recv1, recv2, recv3]);
    expect(r1).toBe(10);
    expect(r2).toBe(20);
    expect(r3).toBe('closed');
  });

  // ─── Async iteration ───

  it('should iterate all values then stop on close', async () => {
    const ch = new Chan<number>();
    const results: number[] = [];

    const consumer = (async () => {
      for await (const value of ch) {
        results.push(value);
      }
    })();

    ch.sendNowait(1);
    ch.sendNowait(2);
    ch.sendNowait(3);
    ch.close();

    await consumer;
    expect(results).toEqual([1, 2, 3]);
  });

  it('should iterate empty channel that is immediately closed', async () => {
    const ch = new Chan<number>();
    ch.close();

    const results: number[] = [];
    for await (const value of ch) {
      results.push(value);
    }
    expect(results).toEqual([]);
  });

  it('should support multiple sequential iterations (separate iterators)', async () => {
    const ch = new Chan<number>();
    ch.sendNowait(1);
    ch.sendNowait(2);
    ch.close();

    // First iterator gets everything
    const results1: number[] = [];
    for await (const value of ch) {
      results1.push(value);
    }
    expect(results1).toEqual([1, 2]);

    // Second iterator on closed channel gets nothing
    const results2: number[] = [];
    for await (const value of ch) {
      results2.push(value);
    }
    expect(results2).toEqual([]);
  });

  it('should handle slow consumer with fast producer', async () => {
    const ch = new Chan<number>();
    const results: number[] = [];

    const consumer = (async () => {
      for await (const value of ch) {
        await new Promise((r) => setTimeout(r, 1));
        results.push(value);
      }
    })();

    for (let i = 0; i < 20; i++) {
      ch.sendNowait(i);
    }
    ch.close();

    await consumer;
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  // ─── Abort signal support ───

  it('should stop iteration when AbortSignal fires', async () => {
    const ch = new Chan<number>();
    const ac = new AbortController();
    const results: number[] = [];

    const consumer = (async () => {
      for await (const value of ch.iter(ac.signal)) {
        results.push(value);
        if (results.length === 3) {
          ac.abort();
        }
      }
    })();

    for (let i = 0; i < 10; i++) {
      ch.sendNowait(i);
    }

    await consumer;
    expect(results).toEqual([0, 1, 2]);

    // Channel is not closed — abort only stops iteration
    expect(ch.closed).toBe(false);
    ch.close();
  });

  it('should handle pre-aborted signal', async () => {
    const ch = new Chan<number>();
    ch.sendNowait(1);
    const ac = new AbortController();
    ac.abort();

    const results: number[] = [];
    for await (const value of ch.iter(ac.signal)) {
      results.push(value);
    }
    expect(results).toEqual([]);
    ch.close();
  });

  it('should stop waiting recv when abort fires', async () => {
    const ch = new Chan<number>();
    const ac = new AbortController();
    const results: number[] = [];

    const consumer = (async () => {
      for await (const value of ch.iter(ac.signal)) {
        results.push(value);
      }
    })();

    ch.sendNowait(1);
    await new Promise((r) => setTimeout(r, 10));
    // Consumer should be waiting for next value
    ac.abort();
    await consumer;

    expect(results).toEqual([1]);
    expect(ch.closed).toBe(false);
    ch.close();
  });

  it('should clean up abort listener when channel closes normally', async () => {
    const ch = new Chan<number>();
    const ac = new AbortController();

    ch.sendNowait(1);
    ch.sendNowait(2);
    ch.close();

    const results: number[] = [];
    for await (const value of ch.iter(ac.signal)) {
      results.push(value);
    }
    expect(results).toEqual([1, 2]);
    // No dangling listeners — abort should be safe to call now
    ac.abort();
  });

  // ─── Resource leak prevention ───

  it('should not leak waiters after close', async () => {
    const ch = new Chan<number>();

    // Start multiple blocked receivers
    const promises = Array.from({ length: 5 }, () => ch.recv().catch(() => {}));

    await new Promise((r) => setTimeout(r, 10));
    ch.close();
    await Promise.all(promises);

    // Internal waiter arrays should be empty
    expect((ch as any)._gets.length).toBe(0);
    expect((ch as any)._puts.length).toBe(0);
  });

  it('should not leak waiters when backpressure resolves', async () => {
    const ch = new Chan<number>(1);
    ch.sendNowait(1);

    const sendPromise = ch.send(2);
    await new Promise((r) => setTimeout(r, 10));

    // Consume to unblock
    await ch.recv();
    await sendPromise;

    expect((ch as any)._puts.length).toBe(0);
    ch.close();
  });

  it('should not leak waiters when iteration completes', async () => {
    const ch = new Chan<number>();
    ch.sendNowait(1);
    ch.sendNowait(2);
    ch.close();

    for await (const _ of ch) {
      // consume
    }

    expect((ch as any)._gets.length).toBe(0);
    expect((ch as any)._puts.length).toBe(0);
  });

  it('should not leak waiters when abort fires during recv', async () => {
    const ch = new Chan<number>();
    const ac = new AbortController();

    const consumer = (async () => {
      const results: number[] = [];
      for await (const value of ch.iter(ac.signal)) {
        results.push(value);
      }
      return results;
    })();

    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await consumer;

    // The abort listener should have cleaned up the waiter
    expect((ch as any)._gets.length).toBe(0);
    ch.close();
  });

  it('should handle many concurrent readers and writers without leaks', async () => {
    const ch = new Chan<number>(5);
    const received: number[] = [];

    // 10 concurrent writers
    const writers = Array.from({ length: 10 }, (_, i) =>
      ch.send(i).catch(() => {
        /* ChanClosed */
      }),
    );

    // 10 concurrent readers
    const readers = Array.from({ length: 10 }, () =>
      ch
        .recv()
        .then((v) => received.push(v))
        .catch(() => {
          /* ChanClosed */
        }),
    );

    await Promise.all([...writers, ...readers]);
    ch.close();

    expect((ch as any)._gets.length).toBe(0);
    expect((ch as any)._puts.length).toBe(0);
  });

  // ─── qsize / empty / full / closed properties ───

  it('should track qsize correctly', () => {
    const ch = new Chan<number>();
    expect(ch.qsize()).toBe(0);
    expect(ch.empty()).toBe(true);

    ch.sendNowait(1);
    expect(ch.qsize()).toBe(1);
    expect(ch.empty()).toBe(false);

    ch.sendNowait(2);
    expect(ch.qsize()).toBe(2);

    ch.recvNowait();
    expect(ch.qsize()).toBe(1);

    ch.recvNowait();
    expect(ch.qsize()).toBe(0);
    expect(ch.empty()).toBe(true);
  });

  it('should report closed correctly', () => {
    const ch = new Chan<number>();
    expect(ch.closed).toBe(false);
    ch.close();
    expect(ch.closed).toBe(true);
  });

  // ─── Edge cases ───

  it('should handle rapid open/send/close cycles', async () => {
    for (let i = 0; i < 100; i++) {
      const ch = new Chan<number>();
      ch.sendNowait(i);
      ch.close();
      const results: number[] = [];
      for await (const v of ch) {
        results.push(v);
      }
      expect(results).toEqual([i]);
    }
  });

  it('should handle large number of items', async () => {
    const ch = new Chan<number>();
    const count = 10_000;

    for (let i = 0; i < count; i++) {
      ch.sendNowait(i);
    }
    ch.close();

    const results: number[] = [];
    for await (const value of ch) {
      results.push(value);
    }
    expect(results.length).toBe(count);
    expect(results[0]).toBe(0);
    expect(results[count - 1]).toBe(count - 1);
  });

  it('should work with async send and recv interleaved', async () => {
    const ch = new Chan<number>();
    const results: number[] = [];

    const producer = (async () => {
      for (let i = 0; i < 5; i++) {
        await ch.send(i);
        await new Promise((r) => setTimeout(r, 1));
      }
      ch.close();
    })();

    const consumer = (async () => {
      for await (const value of ch) {
        results.push(value);
      }
    })();

    await Promise.all([producer, consumer]);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('should handle backpressure with concurrent producer/consumer', async () => {
    const ch = new Chan<number>(3);
    const results: number[] = [];

    const producer = (async () => {
      for (let i = 0; i < 10; i++) {
        await ch.send(i);
      }
      ch.close();
    })();

    const consumer = (async () => {
      for await (const value of ch) {
        await new Promise((r) => setTimeout(r, 2));
        results.push(value);
      }
    })();

    await Promise.all([producer, consumer]);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
