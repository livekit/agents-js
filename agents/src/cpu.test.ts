// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CGroupV1CpuMonitor, CGroupV2CpuMonitor, DefaultCpuMonitor, getCpuMonitor } from './cpu.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe('cpu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NUM_CPUS;
  });

  afterEach(() => {
    delete process.env.NUM_CPUS;
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
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu.stat') {
          callCount++;
          // Two reads: 1,000,000 usec apart => 1s of CPU usage over the interval
          return callCount <= 1
            ? 'usage_usec 1000000\nuser_usec 800000\nsystem_usec 200000'
            : 'usage_usec 2000000\nuser_usec 1600000\nsystem_usec 400000';
        }
        if (String(p) === '/sys/fs/cgroup/cpu.max') return '200000 100000';
        return '';
      });
      const monitor = new CGroupV2CpuMonitor();
      // interval=100ms, 2 cpus, 1s of usage => 1/(0.1*2) = 5, clamped to 1
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

    it('clamps cpuCount to minimum 1.0', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us') return '50000';
        if (String(p) === '/sys/fs/cgroup/cpu/cpu.cfs_period_us') return '100000';
        return '';
      });
      const monitor = new CGroupV1CpuMonitor();
      expect(monitor.cpuCount()).toBe(1.0);
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
