// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

/** @internal */
export interface CpuMonitor {
  cpuCount(): number;
  cpuPercent(intervalMs: number): Promise<number>;
}

function cpuCountFromEnv(): number | undefined {
  const raw = process.env.NUM_CPUS;
  if (raw === undefined) return undefined;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    console.warn('Failed to parse NUM_CPUS from environment');
    return undefined;
  }
  return parsed;
}

/** @internal */
export class DefaultCpuMonitor implements CpuMonitor {
  cpuCount(): number {
    return cpuCountFromEnv() ?? (os.cpus().length || 1);
  }

  cpuPercent(intervalMs: number): Promise<number> {
    return new Promise((resolve) => {
      const cpus1 = os.cpus();
      const timer = setTimeout(() => {
        const cpus2 = os.cpus();
        let idle = 0;
        let total = 0;
        for (let i = 0; i < cpus1.length; i++) {
          const cpu1 = cpus1[i]!.times;
          const cpu2 = cpus2[i]!.times;
          idle += cpu2.idle - cpu1.idle;
          const total1 = Object.values(cpu1).reduce((acc, v) => acc + v, 0);
          const total2 = Object.values(cpu2).reduce((acc, v) => acc + v, 0);
          total += total2 - total1;
        }
        resolve(total === 0 ? 0 : Math.max(Math.min(+(1 - idle / total).toFixed(2), 1), 0));
      }, intervalMs);
      timer.unref();
    });
  }
}

/** @internal */
export class CGroupV2CpuMonitor implements CpuMonitor {
  cpuCount(): number {
    const envCpus = cpuCountFromEnv();
    if (envCpus !== undefined) return envCpus;
    const [quota, period] = this.#readCpuMax();
    if (quota === 'max') return os.cpus().length || 1;
    return parseInt(quota) / period;
  }

  cpuPercent(intervalMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const usageStart = this.#readCpuUsage();
      const timer = setTimeout(() => {
        try {
          const usageEnd = this.#readCpuUsage();
          const usageDiffUsec = usageEnd - usageStart;
          const usageSeconds = usageDiffUsec / 1_000_000;
          const numCpus = this.cpuCount();
          const intervalSeconds = intervalMs / 1000;
          const percent = usageSeconds / (intervalSeconds * numCpus);
          resolve(Math.max(Math.min(percent, 1), 0));
        } catch (e) {
          reject(e);
        }
      }, intervalMs);
      timer.unref();
    });
  }

  #readCpuMax(): [string, number] {
    try {
      const data = readFileSync('/sys/fs/cgroup/cpu.max', 'utf-8').trim().split(/\s+/);
      const quota = data[0] ?? 'max';
      const period = data[1] ? parseInt(data[1]) : 100_000;
      return [quota, Number.isNaN(period) ? 100_000 : period];
    } catch {
      return ['max', 100_000];
    }
  }

  #readCpuUsage(): number {
    const content = readFileSync('/sys/fs/cgroup/cpu.stat', 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('usage_usec')) {
        return parseInt(line.split(/\s+/)[1]!);
      }
    }
    throw new Error('Failed to read CPU usage from /sys/fs/cgroup/cpu.stat');
  }
}

/** @internal */
export class CGroupV1CpuMonitor implements CpuMonitor {
  cpuCount(): number {
    const envCpus = cpuCountFromEnv();
    if (envCpus !== undefined) return envCpus;
    const [quota, period] = this.#readCfsQuotaAndPeriod();
    if (quota === null || quota < 0 || period === null || period <= 0) {
      // do not use the host CPU count as it could overstate the number available to the container
      return 2.0;
    }
    return quota / period;
  }

  cpuPercent(intervalMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const usageStart = this.#readCpuacctUsage();
      const timer = setTimeout(() => {
        try {
          const usageEnd = this.#readCpuacctUsage();
          const usageDiffNs = usageEnd - usageStart;
          const usageSeconds = usageDiffNs / 1_000_000_000;
          const numCpus = this.cpuCount();
          const intervalSeconds = intervalMs / 1000;
          const percent = usageSeconds / (intervalSeconds * numCpus);
          resolve(Math.max(Math.min(percent, 1.0), 0.0));
        } catch (e) {
          reject(e);
        }
      }, intervalMs);
      timer.unref();
    });
  }

  #readCfsQuotaAndPeriod(): [number | null, number | null] {
    const quota = readFirstInt('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
    const period = readFirstInt('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    return [quota, period];
  }

  #readCpuacctUsage(): number {
    const value = readFirstInt('/sys/fs/cgroup/cpuacct/cpuacct.usage');
    if (value === null) {
      throw new Error('Failed to read cpuacct.usage for cgroup v1');
    }
    return value;
  }
}

function readFirstInt(path: string): number | null {
  try {
    const val = parseInt(readFileSync(path, 'utf-8').trim());
    return Number.isNaN(val) ? null : val;
  } catch {
    return null;
  }
}

function isCGroupV2(): boolean {
  return existsSync('/sys/fs/cgroup/cpu.stat');
}

function isCGroupV1(): boolean {
  return existsSync('/sys/fs/cgroup/cpuacct/cpuacct.usage');
}

export function getCpuMonitor(): CpuMonitor {
  if (isCGroupV2()) return new CGroupV2CpuMonitor();
  if (isCGroupV1()) return new CGroupV1CpuMonitor();
  return new DefaultCpuMonitor();
}
