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
    await exitPromise;

    const results = await Promise.all([
      getChildMemoryUsageMB(pid),
      getChildMemoryUsageMB(pid),
      getChildMemoryUsageMB(pid),
    ]);

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
  it('rejects initialize() and produces no unhandled rejections when init times out', async () => {
    // Regression test: before the fix, initialize() would either silently
    // resolve (after a late first-message arrived) or — for a child that
    // never sent a message — hang forever, wedging the pool. It must now
    // reject so the caller can release its mutex slots. The Future's
    // self-attached `.catch` and the race losers' attached `.catch` ensure
    // no rejection escapes as unhandled.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', handler);

    // Child that responds AFTER the timeout — simulates slow init under
    // CPU pressure. Timeout fires at 50 ms, child would respond at 200 ms.
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
      protected get processKind() {
        return 'job';
      }
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
    await expect(proc.initialize()).rejects.toThrow(/timed out|exited before/);

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
    // When init fails (rejected), run() throws at `await this.init.await`,
    // start()'s catch resolves #join, and join() must return promptly so
    // that the pool can release its mutex slots and replenish.
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
      protected get processKind() {
        return 'job';
      }
      createProcess() {
        return fork(slowScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      }
      async mainTask() {}
    }

    const proc = new TestProc(50, 1000, 0, 0, 5000, 60000, 2500);

    await proc.start();
    await expect(proc.initialize()).rejects.toThrow();

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

  it('rejects initialize() when child hangs without ever sending a message (#1748 wedge)', async () => {
    // Reproduces the production wedge in #1748: a child that never sends
    // its first IPC message (e.g. crashed mid-prewarm) used to leave
    // `initialize()` pending forever via `await once(proc, 'message')`,
    // holding initMutex and the procMutex slot and black-holing every
    // subsequent job. With the fix initialize() races the message against
    // exit + timeout, so it always settles.
    const hangScript = join(tmpdir(), 'test_hang_init_child.mjs');
    writeFileSync(
      hangScript,
      // never registers a message handler, never sends anything
      `setInterval(() => {}, 1000);`,
    );

    const { SupervisedProc } = await import('./supervised_proc.js');
    class TestProc extends SupervisedProc {
      protected get processKind() {
        return 'job';
      }
      createProcess() {
        return fork(hangScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      }
      async mainTask() {}
    }

    const proc = new TestProc(150, 1000, 0, 0, 5000, 60000, 2500);

    await proc.start();
    const outcome = await Promise.race([
      proc.initialize().then(
        () => 'resolved' as const,
        (err: Error) => `rejected: ${err.message}` as const,
      ),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 2000)),
    ]);

    proc.proc?.kill();
    try {
      unlinkSync(hangScript);
    } catch {}

    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).not.toBe('pending');
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

// Port of Python tests/test_supervised_proc_memory.py — exercises the pure
// memory-warning bookkeeping helpers without starting a real child process.
describe('memory warning bookkeeping', () => {
  // mirror the module-level constants in supervised_proc.ts
  const MEMORY_WARN_COOLDOWN = 120000;
  const MEMORY_WARN_RESET_DELTA_MB = 50;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeProc = async (memoryWarnMB = 500, memoryLimitMB = 0): Promise<any> => {
    const { SupervisedProc } = await import('./supervised_proc.js');
    class FakeProc extends SupervisedProc {
      protected get processKind() {
        return 'job';
      }
      createProcess(): never {
        throw new Error('not implemented');
      }
      async mainTask() {}
    }
    // (initializeTimeout, closeTimeout, memoryWarnMB, memoryLimitMB, pingInterval, pingTimeout, highPingThreshold)
    return new FakeProc(10000, 10000, memoryWarnMB, memoryLimitMB, 2500, 60000, 500);
  };

  it('rate-limits the warning', async () => {
    const proc = await makeProc();
    // first time over the threshold fires immediately
    expect(proc.shouldEmitMemoryWarning(520, 1000)).toBe(true);
    // samples right after, still above the threshold, are suppressed
    expect(proc.shouldEmitMemoryWarning(521, 1005)).toBe(false);
    expect(proc.shouldEmitMemoryWarning(522, 1010)).toBe(false);
    // once the cooldown elapses it fires again
    expect(proc.shouldEmitMemoryWarning(522, 1000 + MEMORY_WARN_COOLDOWN + 1)).toBe(true);
  });

  it('re-emits on significant growth within the cooldown', async () => {
    const proc = await makeProc();
    expect(proc.shouldEmitMemoryWarning(520, 1000)).toBe(true);
    // well within the cooldown, but usage jumped: re-emit so a real leak surfaces
    const grown = 520 + MEMORY_WARN_RESET_DELTA_MB + 1;
    expect(proc.shouldEmitMemoryWarning(grown, 1005)).toBe(true);
  });

  it('reports baseline and growth in the logging fields', async () => {
    const proc = await makeProc();
    // before a baseline is captured, only the basic fields are present
    let fields = proc.memoryLoggingFields(520.0);
    expect(fields.memoryUsageMB).toBe(520.0);
    expect(fields.memoryWarnMB).toBe(500);
    expect(fields.hasRunningJob).toBe(false);
    expect('uptime' in fields).toBe(true);
    expect('baselineMemoryMB' in fields).toBe(false);

    // once a baseline is set, growth-since-startup is reported
    proc.memoryBaselineMB = 300.0;
    fields = proc.memoryLoggingFields(520.0);
    expect(fields.baselineMemoryMB).toBe(300.0);
    expect(fields.growthMemoryMB).toBe(220.0);
  });

  it('rounds reported memory to one decimal', async () => {
    const proc = await makeProc();
    expect(proc.memoryLoggingFields(520.567).memoryUsageMB).toBe(520.6);
  });

  it('uptime is 0 before start', async () => {
    const proc = await makeProc();
    expect(proc.uptime).toBe(0);
  });

  it('processKind renders into the message string', async () => {
    const proc = await makeProc();
    expect(`${proc.processKind} process`).toBe('job process');
  });
});
