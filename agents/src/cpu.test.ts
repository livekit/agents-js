// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CGroupV1CpuMonitor, CGroupV2CpuMonitor, DefaultCpuMonitor, getCpuMonitor } from './cpu.js';
import { initializeLogger, log } from './log.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

const HOST_CPUS = 8;
const HOST_CPU_INFO = Array.from({ length: HOST_CPUS }, () => ({
  model: '',
  speed: 0,
  times: { idle: 0, irq: 0, nice: 0, sys: 0, user: 0 },
}));
const INTERVAL_MS = 500;
const IDLE_USAGE_USEC = 21_600;
const TORN_READS: [number, number][] = [
  [5260817467, 2548880500],
  [5268770613, 5860175581],
  [5889766280, 5270782758],
  [1210759425, 5271033390],
  [5271381786, 5798443673],
  [5288672329, 1215868554],
];

initializeLogger({ pretty: false, level: 'silent' });

async function sample(
  monitor: CGroupV2CpuMonitor,
  usageStart: number,
  usageEnd: number,
  { elapsedMs = INTERVAL_MS, quota = 'max' }: { elapsedMs?: number; quota?: string } = {},
): Promise<number> {
  const reads = [usageStart, usageEnd];
  mockReadFileSync.mockImplementation((p) => {
    if (String(p) === '/sys/fs/cgroup/cpu.stat') return `usage_usec ${reads.shift()}`;
    if (String(p) === '/sys/fs/cgroup/cpu.max') return `${quota} 100000`;
    return '';
  });

  vi.useFakeTimers();
  const hostCpus = vi.spyOn(os, 'cpus').mockReturnValue(HOST_CPU_INFO);
  const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(elapsedMs);
  try {
    const result = monitor.cpuPercent(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    return await result;
  } finally {
    hostCpus.mockRestore();
    clock.mockRestore();
    vi.useRealTimers();
  }
}

describe('cpu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NUM_CPUS;
  });

  afterEach(() => {
    delete process.env.NUM_CPUS;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('getCpuMonitor', () => {
    it('returns CGroupV2CpuMonitor when /sys/fs/cgroup/cpu.stat exists', () => {
      mockExistsSync.mockImplementation((p) => p === '/sys/fs/cgroup/cpu.stat');
      const monitor = getCpuMonitor();
      expect(monitor).toBeInstanceOf(CGroupV2CpuMonitor);
    });

    it('returns CGroupV1CpuMonitor when cgroup v1 paths exist', () => {
      mockExistsSync.mockImplementation((p) => p === '/sys/fs/cgroup/cpuacct/cpuacct.usage');
      const monitor = getCpuMonitor();
      expect(monitor).toBeInstanceOf(CGroupV1CpuMonitor);
    });

    it('returns DefaultCpuMonitor when no cgroup paths exist', () => {
      mockExistsSync.mockReturnValue(false);
      const monitor = getCpuMonitor();
      expect(monitor).toBeInstanceOf(DefaultCpuMonitor);
    });
  });

  describe('DefaultCpuMonitor', () => {
    it('returns os.cpus().length for cpuCount', () => {
      const monitor = new DefaultCpuMonitor();
      expect(monitor.cpuCount()).toBe(os.cpus().length);
    });

    it('respects NUM_CPUS env var', () => {
      process.env.NUM_CPUS = '4.5';
      const monitor = new DefaultCpuMonitor();
      expect(monitor.cpuCount()).toBe(4.5);
    });

    it('ignores invalid NUM_CPUS', () => {
      process.env.NUM_CPUS = 'notanumber';
      const monitor = new DefaultCpuMonitor();
      expect(monitor.cpuCount()).toBe(os.cpus().length);
    });

    it('cpuPercent returns value in [0, 1]', async () => {
      const monitor = new DefaultCpuMonitor();
      const result = await monitor.cpuPercent(50);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }, 10_000);
  });

  describe('CGroupV2CpuMonitor', () => {
    it('returns quota/period for cpuCount', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu.max') return '200000 100000';
        return '';
      });
      const monitor = new CGroupV2CpuMonitor();
      expect(monitor.cpuCount()).toBe(2);
    });

    it('falls back to os.cpus().length when quota is max', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu.max') return 'max 100000';
        return '';
      });
      const monitor = new CGroupV2CpuMonitor();
      expect(monitor.cpuCount()).toBe(os.cpus().length);
    });

    it('handles missing cpu.max gracefully', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const monitor = new CGroupV2CpuMonitor();
      expect(monitor.cpuCount()).toBe(os.cpus().length);
    });

    it('respects NUM_CPUS env var', () => {
      process.env.NUM_CPUS = '3';
      const monitor = new CGroupV2CpuMonitor();
      expect(monitor.cpuCount()).toBe(3);
    });

    it('cpuPercent computes correct value from usage_usec deltas', async () => {
      let callCount = 0;
      vi.spyOn(os, 'cpus').mockReturnValue(HOST_CPU_INFO);
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu.stat') {
          callCount++;
          // Two reads: 500,000 usec apart => 0.5s of CPU usage over the interval
          return callCount <= 1
            ? 'usage_usec 1000000\nuser_usec 800000\nsystem_usec 200000'
            : 'usage_usec 1500000\nuser_usec 1200000\nsystem_usec 300000';
        }
        if (String(p) === '/sys/fs/cgroup/cpu.max') return '200000 100000';
        return '';
      });
      const monitor = new CGroupV2CpuMonitor();
      // interval=100ms, 2 cpus, 0.5s of usage => 0.5/(0.1*2) = 2.5, clamped to 1
      const result = await monitor.cpuPercent(100);
      expect(result).toBe(1);
    }, 10_000);

    it('cpuPercent returns fractional load', async () => {
      let callCount = 0;
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu.stat') {
          callCount++;
          // 50,000 usec delta => 0.05s of CPU over 0.1s on 2 cpus => 0.05/(0.1*2) = 0.25
          return callCount <= 1 ? 'usage_usec 1000000\n' : 'usage_usec 1050000\n';
        }
        if (String(p) === '/sys/fs/cgroup/cpu.max') return '200000 100000';
        return '';
      });
      const monitor = new CGroupV2CpuMonitor();
      const result = await monitor.cpuPercent(100);
      expect(result).toBeCloseTo(0.25, 1);
    }, 10_000);

    it('throws when usage_usec is missing from cpu.stat', async () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu.stat') return 'user_usec 800000\nsystem_usec 200000';
        return '';
      });
      const monitor = new CGroupV2CpuMonitor();
      await expect(() => monitor.cpuPercent(50)).rejects.toThrow('Failed to read CPU usage');
    });

    it.each([500, 600])('uses the measured elapsed time (%dms)', async (elapsedMs) => {
      const monitor = new CGroupV2CpuMonitor();
      const result = await sample(monitor, 5_000_000_000, 5_001_000_000, { elapsedMs });
      expect(result).toBeCloseTo(1 / ((elapsedMs / 1000) * HOST_CPUS));
    });

    it('holds the previous sample for a negative delta', async () => {
      const monitor = new CGroupV2CpuMonitor();
      const good = await sample(monitor, 5_000_000_000, 5_001_000_000);
      const warning = vi.spyOn(log(), 'warn');

      expect(await sample(monitor, ...TORN_READS[0]!)).toBe(good);
      expect(warning).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining('impossible'),
      );
    });

    it('holds the previous sample for an over-ceiling delta', async () => {
      const monitor = new CGroupV2CpuMonitor();
      const good = await sample(monitor, 5_000_000_000, 5_001_000_000);
      const warning = vi.spyOn(log(), 'warn');
      const result = await sample(monitor, ...TORN_READS[1]!);

      expect(result).toBe(good);
      expect(result).not.toBe(1);
      expect(warning).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining('impossible'),
      );
    });

    it('reads an idle load for the first discarded sample', async () => {
      const monitor = new CGroupV2CpuMonitor();
      expect(await sample(monitor, ...TORN_READS[0]!)).toBe(0);
    });

    it('keeps the reporter pattern below the load threshold', async () => {
      const monitor = new CGroupV2CpuMonitor();
      let idle = 5_270_000_000;
      const samples: number[] = [];
      const reads = [
        null,
        null,
        ...TORN_READS.slice(0, 3),
        null,
        ...TORN_READS.slice(3),
        null,
        null,
      ];
      const idlePercent = IDLE_USAGE_USEC / 1_000_000 / (INTERVAL_MS / 1000) / HOST_CPUS;

      for (const torn of reads) {
        const [usageStart, usageEnd] = torn ?? [idle, idle + IDLE_USAGE_USEC];
        idle += IDLE_USAGE_USEC;
        samples.push(await sample(monitor, usageStart, usageEnd));
        const average =
          samples.slice(-5).reduce((sum, value) => sum + value, 0) / Math.min(5, samples.length);
        expect(average).toBeCloseTo(idlePercent);
      }
    });

    it('treats a delta at the host ceiling as full load', async () => {
      const monitor = new CGroupV2CpuMonitor();
      const full = (INTERVAL_MS / 1000) * HOST_CPUS * 1_000_000;
      expect(await sample(monitor, 5_000_000_000, 5_000_000_000 + full)).toBe(1);
    });

    it('clamps a burst above quota instead of discarding it', async () => {
      const monitor = new CGroupV2CpuMonitor();
      const warning = vi.spyOn(log(), 'warn');
      mockReadFileSync.mockReturnValue('200000 100000');

      expect(monitor.cpuCount()).toBe(2);
      expect(await sample(monitor, 5_000_000_000, 5_002_000_000, { quota: '200000' })).toBe(1);
      expect(warning).not.toHaveBeenCalled();
    });
  });

  describe('CGroupV1CpuMonitor', () => {
    it('returns quota/period for cpuCount', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us') return '200000';
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_period_us') return '100000';
        return '';
      });
      const monitor = new CGroupV1CpuMonitor();
      expect(monitor.cpuCount()).toBe(2);
    });

    it('defaults to 2.0 when quota is -1', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us') return '-1';
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_period_us') return '100000';
        return '';
      });
      const monitor = new CGroupV1CpuMonitor();
      expect(monitor.cpuCount()).toBe(2.0);
    });

    it('defaults to 2.0 when quota file is unreadable', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const monitor = new CGroupV1CpuMonitor();
      expect(monitor.cpuCount()).toBe(2.0);
    });

    it('returns fractional cpuCount for sub-CPU limits', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us') return '50000';
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_period_us') return '100000';
        return '';
      });
      const monitor = new CGroupV1CpuMonitor();
      expect(monitor.cpuCount()).toBe(0.5);
    });

    it('respects NUM_CPUS env var', () => {
      process.env.NUM_CPUS = '8';
      const monitor = new CGroupV1CpuMonitor();
      expect(monitor.cpuCount()).toBe(8);
    });

    it('cpuPercent computes correct value from nanosecond deltas', async () => {
      let callCount = 0;
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpuacct/cpuacct.usage') {
          callCount++;
          // 100_000_000 ns delta = 0.1s CPU over 0.1s interval on 2 cpus => 0.1/(0.1*2) = 0.5
          return callCount <= 1 ? '1000000000' : '1100000000';
        }
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us') return '200000';
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_period_us') return '100000';
        return '';
      });
      const monitor = new CGroupV1CpuMonitor();
      const result = await monitor.cpuPercent(100);
      expect(result).toBeCloseTo(0.5, 1);
    }, 10_000);

    it('clamps cpuPercent output to [0, 1]', async () => {
      let callCount = 0;
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpuacct/cpuacct.usage') {
          callCount++;
          // Huge delta => would exceed 1.0 without clamping
          return callCount <= 1 ? '0' : '10000000000';
        }
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us') return '100000';
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_period_us') return '100000';
        return '';
      });
      const monitor = new CGroupV1CpuMonitor();
      const result = await monitor.cpuPercent(100);
      expect(result).toBeLessThanOrEqual(1);
      expect(result).toBeGreaterThanOrEqual(0);
    }, 10_000);

    it('throws when cpuacct.usage is unreadable', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const monitor = new CGroupV1CpuMonitor();
      await expect(() => monitor.cpuPercent(50)).rejects.toThrow('Failed to read cpuacct.usage');
    });
  });
});
