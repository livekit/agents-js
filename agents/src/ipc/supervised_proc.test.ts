// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { fork, spawn } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pidusage from 'pidusage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const childScript = join(tmpdir(), 'test_child.mjs');

beforeAll(() => {
  writeFileSync(
    childScript,
    `process.on('message', (msg) => process.send?.({ echo: msg }));
     setInterval(() => {}, 1000);`,
  );
});

afterAll(() => {
  try {
    unlinkSync(childScript);
  } catch {}
});

async function getChildMemoryUsageMB(pid: number | undefined): Promise<number> {
  if (!pid) return 0;
  try {
    const stats = await pidusage(pid);
    return stats.memory / (1024 * 1024);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') {
      return 0;
    }
    throw err;
  }
}

describe('pidusage on dead process', () => {
  it('raw pidusage throws on dead pid', async () => {
    const child = spawn('sleep', ['10']);
    const pid = child.pid!;

    child.kill('SIGKILL');
    await new Promise<void>((r) => child.on('exit', r));

    await expect(pidusage(pid)).rejects.toThrow();
  });

  it('fixed version returns 0 instead of crashing', async () => {
    const child = spawn('sleep', ['10']);
    const pid = child.pid!;

    child.kill('SIGKILL');
    await new Promise<void>((r) => child.on('exit', r));

    const mem = await getChildMemoryUsageMB(pid);
    expect(mem).toBe(0);
  });

  it('handles concurrent calls on dying process', async () => {
    const child = spawn('sleep', ['10']);
    const pid = child.pid!;
    const exitPromise = new Promise<void>((r) => child.on('exit', r));

    child.kill('SIGKILL');

    const results = await Promise.all([
      getChildMemoryUsageMB(pid),
      getChildMemoryUsageMB(pid),
      getChildMemoryUsageMB(pid),
    ]);

    await exitPromise;
    expect(results.every((r) => r === 0)).toBe(true);
  });
});

describe('IPC send on dead process', () => {
  it('child.connected becomes false when child dies', async () => {
    const child = fork(childScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const exitPromise = new Promise<void>((r) => child.on('exit', r));

    await new Promise((r) => setTimeout(r, 50));
    expect(child.connected).toBe(true);

    child.kill('SIGKILL');
    await exitPromise;

    expect(child.connected).toBe(false);
  });

  it('checking connected before send prevents crash', async () => {
    const child = fork(childScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const exitPromise = new Promise<void>((r) => child.on('exit', r));

    // Suppress EPIPE errors that can occur due to race conditions between
    // child.connected check and the actual pipe state
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err;
    });

    let sent = 0;
    let skipped = 0;

    const interval = setInterval(() => {
      if (child.connected) {
        child.send({ ping: Date.now() });
        sent++;
      } else {
        skipped++;
      }
    }, 20);

    await new Promise((r) => setTimeout(r, 60));
    child.kill('SIGKILL');
    await exitPromise;
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(interval);

    expect(sent).toBeGreaterThan(0);
    expect(skipped).toBeGreaterThan(0);
  });
});

describe('init timeout rejection handling', () => {
  it('does not produce unhandled rejection when init times out', async () => {
    // Regression test: before the fix, run() was called without await in start().
    // When init timed out, the rejection in run()'s `await this.init.await` escaped
    // as an unhandled rejection — crashing the Node.js process.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', handler);

    // Child that responds AFTER the timeout — simulates slow init under CPU pressure.
    // Timeout fires at 50ms (init.reject), child responds at 200ms (once() resolves).
    // Before the fix, init.reject caused an unhandled rejection in run().
    const slowScript = join(tmpdir(), 'test_slow_init_child.mjs');
    writeFileSync(
      slowScript,
      `process.on('message', () => {
        setTimeout(() => process.send({ case: 'initializeResponse' }), 200);
      });
      setInterval(() => {}, 1000);`,
    );

    const { SupervisedProc } = await import('./supervised_proc.js');
    class TestProc extends SupervisedProc {
      createProcess() {
        return fork(slowScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      }
      async mainTask() {}
    }

    const proc = new TestProc(
      50, // initializeTimeout — fires before child responds at 200ms
      1000, // closeTimeout
      0, // memoryWarnMB
      0, // memoryLimitMB
      5000, // pingInterval
      60000, // pingTimeout
      2500, // highPingThreshold
    );

    await proc.start();
    // initialize() returns normally: child responds at 200ms, once() resolves,
    // but init was already rejected at 50ms — run() gets the rejection.
    await proc.initialize();

    // Give the event loop a tick for any unhandled rejection to surface
    await new Promise((r) => setTimeout(r, 100));

    process.off('unhandledRejection', handler);
    proc.proc?.kill();
    try {
      unlinkSync(slowScript);
    } catch {}

    expect(unhandled).toEqual([]);
  });

  it('join() resolves after init timeout instead of hanging forever', async () => {
    // When run() fails early (before registering proc event handlers),
    // #join must still resolve so that join() and close() don't hang.
    const slowScript = join(tmpdir(), 'test_slow_init_child_join.mjs');
    writeFileSync(
      slowScript,
      `process.on('message', () => {
        setTimeout(() => process.send({ case: 'initializeResponse' }), 200);
      });
      setInterval(() => {}, 1000);`,
    );

    const { SupervisedProc } = await import('./supervised_proc.js');
    class TestProc extends SupervisedProc {
      createProcess() {
        return fork(slowScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      }
      async mainTask() {}
    }

    const proc = new TestProc(50, 1000, 0, 0, 5000, 60000, 2500);

    await proc.start();
    await proc.initialize();

    // join() must resolve within a reasonable time, not hang forever
    const result = await Promise.race([
      proc.join().then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('timeout'), 2000)),
    ]);

    proc.proc?.kill();
    try {
      unlinkSync(slowScript);
    } catch {}

    expect(result).toBe('resolved');
  });
});

describe('timer cleanup', () => {
  it('clearInterval stops the interval', async () => {
    let count = 0;
    const interval = setInterval(() => count++, 30);

    await new Promise((r) => setTimeout(r, 80));
    const countAtClear = count;
    clearInterval(interval);

    await new Promise((r) => setTimeout(r, 80));
    expect(count).toBe(countAtClear);
  });

  it('double clear is safe', () => {
    const interval = setInterval(() => {}, 100);
    const timeout = setTimeout(() => {}, 1000);

    clearInterval(interval);
    clearTimeout(timeout);

    expect(() => {
      clearInterval(interval);
      clearTimeout(timeout);
    }).not.toThrow();
  });
});
