// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
async function defaultLoadFunc() {
  vi.resetModules();
  const { ServerOptions } = await import('./worker.js');
  const opts = new ServerOptions({ agent: 'test-agent.js' });
  return () => opts.loadFunc({} as AgentServer);
}

const sample = (value: number, intervalMs: number) =>
  new Promise<number>((resolve) => setTimeout(() => resolve(value), intervalMs));

describe('default load', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    monitor.cpuPercent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('averages the last 5 samples of 0.5s', async () => {
    let n = 0;
    monitor.cpuPercent.mockImplementation((ms) => sample(++n / 10, ms));
    const load = await defaultLoadFunc();

    expect(await load()).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(await load()).toBeCloseTo(0.1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(await load()).toBeCloseTo((0.1 + 0.2 + 0.3 + 0.4 + 0.5) / 5);

    await vi.advanceTimersByTimeAsync(500);
    expect(await load()).toBeCloseTo((0.2 + 0.3 + 0.4 + 0.5 + 0.6) / 5);
    expect(monitor.cpuPercent).toHaveBeenCalledWith(500);
  });

  it('waits before it samples again when cpu stats are unreadable', async () => {
    // cgroup monitors reject at once when they cannot read usage. After 100
    // failures the fake recovers, so a loop that does not wait fails the test
    // rather than hangs it.
    let calls = 0;
    monitor.cpuPercent.mockImplementation((ms) =>
      ++calls <= 100 ? Promise.reject(new Error('no cpu stats')) : sample(0.5, ms),
    );
    const load = await defaultLoadFunc();

    expect(await load()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(3);
  });
});
