// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Quick smoke test: run getCpuMonitor() inside a container
// and print the detected monitor type, CPU count, and a load sample.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import {
  CGroupV1CpuMonitor,
  CGroupV2CpuMonitor,
  DefaultCpuMonitor,
  getCpuMonitor,
} from '../../agents/dist/cpu.js';

function monitorName(m) {
  if (m instanceof CGroupV2CpuMonitor) return 'CGroupV2CpuMonitor';
  if (m instanceof CGroupV1CpuMonitor) return 'CGroupV1CpuMonitor';
  if (m instanceof DefaultCpuMonitor) return 'DefaultCpuMonitor';
  return m.constructor.name;
}

console.log('=== Container CPU Monitor Test ===');
console.log('os.cpus().length (host value):', os.cpus().length);
console.log('/sys/fs/cgroup/cpu.stat exists:', existsSync('/sys/fs/cgroup/cpu.stat'));
console.log(
  '/sys/fs/cgroup/cpu/cpu.cfs_quota_us exists:',
  existsSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
);
console.log('/.dockerenv exists:', existsSync('/.dockerenv'));

if (existsSync('/sys/fs/cgroup/cpu.stat')) {
  try {
    console.log('\n--- /sys/fs/cgroup/cpu.stat ---');
    console.log(
      readFileSync('/sys/fs/cgroup/cpu.stat', 'utf-8').split('\n').slice(0, 5).join('\n'),
    );
  } catch (e) {
    console.log('  (unreadable:', e.message, ')');
  }
}
if (existsSync('/sys/fs/cgroup/cpu.max')) {
  try {
    console.log('\n--- /sys/fs/cgroup/cpu.max ---');
    console.log(readFileSync('/sys/fs/cgroup/cpu.max', 'utf-8').trim());
  } catch (e) {
    console.log('  (unreadable:', e.message, ')');
  }
}

console.log('\n--- Monitor Detection ---');
const monitor = getCpuMonitor();
console.log('Selected monitor:', monitorName(monitor));
console.log('cpuCount():', monitor.cpuCount());

console.log('\nSampling CPU load (500ms)...');
// Keep the event loop alive while sampling -- in the real worker the setInterval does this,
// but in this isolated script the unref'd timer would let the process exit early.
const keepAlive = setInterval(() => {}, 60000);
const load = await monitor.cpuPercent(500);
clearInterval(keepAlive);
console.log('cpuPercent():', load);
console.log('Load in [0, 1]:', load >= 0 && load <= 1 ? 'PASS' : 'FAIL');
