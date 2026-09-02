// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { fork, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pidusage from 'pidusage';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '../log.js';
import type { IPCMessage } from './message.js';
import { type ProcOpts, SupervisedProc } from './supervised_proc.js';

const procOptions = (overrides: Partial<ProcOpts> = {}): ProcOpts => ({
  initializeTimeout: 100,
  closeTimeout: 20,
  memoryWarnMB: 0,
  memoryLimitMB: 0,
  pingInterval: 5000,
  pingTimeout: 60000,
  highPingThreshold: 2500,
  ...overrides,
});

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

describe('supervised process shutdown', () => {
  async function createProc({
    closeTimeout = 20,
    pingInterval = 5000,
    pingTimeout = 60_000,
    acknowledgeShutdown = true,
    completeSessionEnd = false,
    completeWithDone = false,
    respondToPings = false,
    memoryLimitMB = 0,
  } = {}) {
    type TestChild = EventEmitter & {
      connected: boolean;
      exitCode: number | null;
      killed: boolean;
      send: (message: IPCMessage) => boolean;
      kill: (signal?: NodeJS.Signals | number) => boolean;
    };

    const child = new EventEmitter() as TestChild;
    child.connected = true;
    child.exitCode = null;
    child.killed = false;
    const sendSpy = vi.fn((message: IPCMessage) => {
      if (message.case === 'initializeRequest') {
        queueMicrotask(() =>
          child.emit('message', {
            case: 'initializeResponse',
            value: undefined,
          } satisfies IPCMessage),
        );
      } else if (message.case === 'pingRequest' && respondToPings) {
        queueMicrotask(() =>
          child.emit('message', {
            case: 'pongResponse',
            value: { lastTimestamp: message.value.timestamp, timestamp: Date.now() },
          } satisfies IPCMessage),
        );
      } else if (message.case === 'shutdownRequest') {
        queueMicrotask(() => {
          if (acknowledgeShutdown) {
            child.emit('message', {
              case: 'shutdownRequestAck',
              value: undefined,
            } satisfies IPCMessage);
          }
          if (completeSessionEnd) {
            child.emit('message', { case: 'shuttingDown', value: undefined } satisfies IPCMessage);
          }
          if (completeWithDone) {
            child.emit('message', { case: 'done', value: undefined } satisfies IPCMessage);
            child.connected = false;
            child.exitCode = 0;
            child.emit('exit', 0, null);
          }
        });
      }
      return true;
    });
    const killSpy = vi.fn(() => {
      child.killed = true;
      child.connected = false;
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
      return true;
    });
    child.send = sendSpy;
    child.kill = killSpy;

    class TestProc extends SupervisedProc {
      protected get processKind() {
        return 'job';
      }

      createProcess(): ChildProcess {
        return child as unknown as ChildProcess;
      }

      async mainTask() {}
    }

    const proc = new TestProc(
      procOptions({ closeTimeout, memoryLimitMB, pingInterval, pingTimeout }),
    );
    await proc.start();
    await proc.initialize({ sessionEndTimeout: 300_000 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    return { child, killSpy, proc, sendSpy };
  }

  it('waits for session-end handling without applying the process close timeout', async () => {
    const { child, killSpy, proc, sendSpy } = await createProc({
      pingInterval: 5,
      pingTimeout: 30,
      respondToPings: true,
    });
    const close = proc.close();

    await vi.waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith({
        case: 'shutdownRequest',
        value: { reason: 'shutdown request' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(killSpy).not.toHaveBeenCalled();

    child.emit('message', { case: 'shuttingDown', value: undefined } satisfies IPCMessage);
    child.emit('message', { case: 'done', value: undefined } satisfies IPCMessage);
    child.connected = false;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await close;
  });

  it('sends the session end timeout in the typed initialize request', async () => {
    const { child, proc, sendSpy } = await createProc();

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        case: 'initializeRequest',
        value: expect.objectContaining({ sessionEndTimeout: 300_000 }),
      }),
    );

    child.emit('message', { case: 'done', value: undefined } satisfies IPCMessage);
    child.connected = false;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await proc.join();
  });

  it('logs the exit reason with the Python-compatible reason field', async () => {
    const debug = vi.fn();
    const childLogger = vi.fn().mockReturnValue({ debug } as unknown as Logger);
    const logger = { child: childLogger } as unknown as Logger;
    const rootChild = vi.spyOn(log(), 'child').mockReturnValueOnce(logger);

    try {
      const { child, proc } = await createProc();
      child.emit('message', {
        case: 'exiting',
        value: { reason: 'user requested' },
      } satisfies IPCMessage);

      expect(childLogger).toHaveBeenCalledExactlyOnceWith({ reason: 'user requested' });

      child.emit('message', { case: 'done', value: undefined } satisfies IPCMessage);
      child.connected = false;
      child.exitCode = 0;
      child.emit('exit', 0, null);
      await proc.join();
    } finally {
      rootChild.mockRestore();
    }
  });

  it('still bounds process teardown after session-end handling completes', async () => {
    const { killSpy, proc } = await createProc({ completeSessionEnd: true });

    await proc.close();

    expect(killSpy).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('kills the child when it does not acknowledge shutdown', async () => {
    const { killSpy, proc } = await createProc({ acknowledgeShutdown: false });

    await proc.close();

    expect(killSpy).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('keeps the watchdog active while waiting for session-end handling', async () => {
    const { killSpy, proc } = await createProc({ pingInterval: 5, pingTimeout: 30 });

    await proc.close();

    expect(killSpy).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('accepts done as completion of both shutdown stages', async () => {
    const { killSpy, proc } = await createProc({
      acknowledgeShutdown: false,
      completeWithDone: true,
    });

    await proc.close();

    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills an over-limit child without starting staged shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      const { killSpy, proc, sendSpy } = await createProc({ memoryLimitMB: 100 });
      const internals = proc as unknown as {
        getChildMemoryUsageMB(): Promise<number>;
      };
      vi.spyOn(internals, 'getChildMemoryUsageMB').mockResolvedValue(101);

      await vi.runOnlyPendingTimersAsync();

      expect(killSpy).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(sendSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ case: 'shutdownRequest' }),
      );
    } finally {
      vi.useRealTimers();
    }
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
      protected get processKind() {
        return 'job';
      }
      createProcess() {
        return fork(slowScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      }
      async mainTask() {}
    }

    const proc = new TestProc(procOptions({ initializeTimeout: 50, closeTimeout: 1000 }));

    await proc.start();
    // initialize() now fails fast: the timeout fires at 50ms and rejects the
    // call itself (the child's 200ms response arrives too late). The rejection
    // must be delivered to the caller, not escape as an unhandled rejection.
    await expect(proc.initialize()).rejects.toThrow('runner initialization timed out');

    // Give the event loop a tick for any unhandled rejection to surface
    await new Promise((r) => setTimeout(r, 200));

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
      protected get processKind() {
        return 'job';
      }
      createProcess() {
        return fork(slowScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      }
      async mainTask() {}
    }

    const proc = new TestProc(procOptions({ initializeTimeout: 50, closeTimeout: 1000 }));

    await proc.start();
    await proc.initialize().catch(() => {}); // times out at 50ms

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

  it('kills the child when initialize times out', async () => {
    // A child that never responds would survive a failed initialize() —
    // initialize() must kill it so the process doesn't leak.
    const hangScript = join(tmpdir(), 'test_hang_init_child.mjs');
    writeFileSync(hangScript, `setInterval(() => {}, 1000);`);

    const { SupervisedProc } = await import('./supervised_proc.js');
    class TestProc extends SupervisedProc {
      createProcess() {
        return fork(hangScript, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      }
      async mainTask() {}
    }

    const proc = new TestProc(procOptions({ initializeTimeout: 50, closeTimeout: 1000 }));

    await proc.start();
    const exited = new Promise<void>((r) => proc.proc!.on('exit', () => r()));
    await expect(proc.initialize()).rejects.toThrow('runner initialization timed out');

    const result = await Promise.race([
      exited.then(() => 'exited'),
      new Promise((r) => setTimeout(() => r('timeout'), 2000)),
    ]);

    proc.proc?.kill();
    try {
      unlinkSync(hangScript);
    } catch {}

    expect(result).toBe('exited');
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
    return new FakeProc(
      procOptions({
        initializeTimeout: 10000,
        closeTimeout: 10000,
        memoryWarnMB,
        memoryLimitMB,
        pingInterval: 2500,
        highPingThreshold: 500,
      }),
    );
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
