// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { RegisterWorkerResponse, ServerMessage, WorkerMessage } from '@livekit/protocol';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { Future } from './utils.js';
import type { AgentServer } from './worker.js';

const monitor = vi.hoisted(() => ({
  cpuCount: vi.fn(() => 1),
  cpuPercent: vi.fn<(intervalMs: number) => Promise<number>>(),
}));

vi.mock('./cpu.js', () => ({ getCpuMonitor: () => monitor }));
vi.mock('./inference/_warmup.js', () => ({
  _getLocalInferenceModule: () => undefined,
}));

// the default load calculator is created once per module, so each test loads
// its own copy of the worker module
async function loadWorker() {
  vi.resetModules();
  const worker = await import('./worker.js');
  const opts = new worker.ServerOptions({ agent: 'test-agent.js' });
  return { worker, load: () => opts.loadFunc({} as AgentServer) };
}

// resolves after intervalMs with the cpu value at that time
let cpu = 0;
const sample = (intervalMs: number) =>
  new Promise<number>((resolve) => setTimeout(() => resolve(cpu), intervalMs));

describe('default load', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cpu = 0;
    monitor.cpuPercent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('measures at once before the first sample', async () => {
    monitor.cpuPercent.mockImplementation(sample);
    const { load } = await loadWorker();

    cpu = 0.9;
    const first = load();
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toBeCloseTo(0.9);
  });

  it('averages the last 5 samples of 0.5s', async () => {
    monitor.cpuPercent.mockImplementation(sample);
    const { load } = await loadWorker();

    void load(); // starts the sampler
    for (const value of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      cpu = value;
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(await load()).toBeCloseTo((0.1 + 0.2 + 0.3 + 0.4 + 0.5) / 5);

    cpu = 0.6;
    await vi.advanceTimersByTimeAsync(500);
    expect(await load()).toBeCloseTo((0.2 + 0.3 + 0.4 + 0.5 + 0.6) / 5);
    expect(monitor.cpuPercent).toHaveBeenCalledWith(500);
  });

  it('drops old samples and reports the error when cpu stats become unreadable', async () => {
    let fail = false;
    monitor.cpuPercent.mockImplementation((ms) =>
      fail ? Promise.reject(new Error('no cpu stats')) : sample(ms),
    );
    const { load } = await loadWorker();

    cpu = 0.2;
    void load();
    await vi.advanceTimersByTimeAsync(500);
    expect(await load()).toBeCloseTo(0.2);

    fail = true;
    await vi.advanceTimersByTimeAsync(500);
    await expect(load()).rejects.toThrow('no cpu stats');
  });

  it('waits before it samples again when cpu stats are unreadable', async () => {
    // cgroup monitors reject at once when they cannot read usage. After 100
    // failures the fake recovers, so a loop that does not wait fails the test
    // rather than hangs it.
    let calls = 0;
    monitor.cpuPercent.mockImplementation((ms) =>
      ++calls <= 100 ? Promise.reject(new Error('no cpu stats')) : sample(ms),
    );
    const { load } = await loadWorker();

    // one call from the sampler, one from the direct measurement
    await expect(load()).rejects.toThrow('no cpu stats');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(4);
  });

  it('stops sampling once the worker has closed', async () => {
    monitor.cpuPercent.mockImplementation(sample);
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, 'listening');
    const registered = new Future();
    wss.on('connection', (ws) => {
      ws.on('message', (data: Buffer) => {
        const msg = WorkerMessage.fromBinary(new Uint8Array(data));
        if (msg.message.case === 'register') {
          const res = new RegisterWorkerResponse({ workerId: 'AW_test' });
          ws.send(new ServerMessage({ message: { case: 'register', value: res } }).toBinary());
          registered.resolve();
        }
      });
    });

    const { worker } = await loadWorker();
    // keep the worker connected while it closes, so status ticks run during teardown
    const { ProcPool } = await import('./ipc/proc_pool.js');
    const poolClosed = new Future();
    const poolClose = vi
      .spyOn(ProcPool.prototype, 'close')
      .mockImplementation(() => poolClosed.await);
    const server = new worker.AgentServer(
      new worker.ServerOptions({
        agent: 'test-agent.js',
        wsURL: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        apiKey: 'devkey',
        apiSecret: 'devsecret',
        numIdleProcesses: 0,
        simulation: true,
      }),
    );

    const run = server.run().catch(() => undefined);
    try {
      await registered.await;
      await vi.advanceTimersByTimeAsync(3000);
      expect(monitor.cpuPercent).toHaveBeenCalled();

      const closing = server.close();
      await vi.advanceTimersByTimeAsync(3000);
      poolClosed.resolve();
      await closing;
      await run;

      // the samples in progress finish, then the sampler exits
      await vi.advanceTimersByTimeAsync(500);
      const calls = monitor.cpuPercent.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(monitor.cpuPercent.mock.calls.length).toBe(calls);
    } finally {
      poolClosed.resolve();
      poolClose.mockRestore();
      wss.close();
    }
  });
});
