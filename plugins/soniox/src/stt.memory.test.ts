// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Build the plugin first. A separate process keeps forced GC out of the test runner.
it('does not retain already-sent audio frames while the stream remains open', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
import { once } from 'node:events';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { initializeLogger } from '@livekit/agents';
import { STT } from './dist/index.js';
import { AudioFrame } from '@livekit/rtc-node';
import { WebSocketServer } from 'ws';

if (!global.gc) throw new Error('Run with node --expose-gc');
initializeLogger({ pretty: false, level: 'silent' });
const watchdog = setTimeout(() => {
  console.error('Reproduction timed out');
  process.exit(1);
}, 30000);

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
let received = 0;
let socketClosed = false;
server.on('connection', socket => {
  socket.on('message', (_data, binary) => { if (binary) received++; });
  socket.on('close', () => { socketClosed = true; });
});

const provider = new STT({
  apiKey: 'local-placeholder',
  baseUrl: \`ws://127.0.0.1:\${server.address().port}\`,
  sampleRate: 16000,
  numChannels: 1,
});
const errors = [];
provider.on('error', event => errors.push(String(event.error)));
const stream = provider.stream({ connOptions: { maxRetry: 0 } });
const consumer = (async () => {
  for await (const _event of stream) { /* Drain output. */ }
})().catch(error => { errors.push(String(error)); });

let sent = 0;
async function send(count) {
  const target = sent + count;
  while (sent < target) {
    for (let i = 0; i < 100 && sent < target; i++) {
      stream.pushFrame(new AudioFrame(new Int16Array(320), 16000, 1, 320));
      sent++;
    }
    while (received < sent) {
      if (errors.length) throw new Error(errors.join('\\n'));
      await turn();
    }
  }
}
async function measure(label) {
  // Move beyond frame-processing callbacks before forcing GC.
  await turn();
  global.gc();
  await turn();
  global.gc();
  const m = process.memoryUsage();
  const mib = value => +(value / 2 ** 20).toFixed(2);
  const row = { label, received, heapMiB: mib(m.heapUsed),
    arrayBuffersMiB: mib(m.arrayBuffers), rssMiB: mib(m.rss) };
  console.log(JSON.stringify(row));
  return row;
}

await send(3000);
const baseline = await measure('warmup: stream open');
await send(90000);
const active = await measure('90000 additional frames: stream open');
console.log(JSON.stringify({ activeHeapDeltaMiB: +(active.heapMiB - baseline.heapMiB).toFixed(2) }));
stream.close();
await consumer;
while (!socketClosed) await delay(10);
await measure('stream and websocket closed');
await provider.close();
await new Promise(resolve => server.close(resolve));
clearTimeout(watchdog);
if (errors.length) throw new Error(errors.join('\\n'));

    `,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 40000,
    },
  );
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const [baseline, active, , closed] = rows;
  expect(active.received).toBe(93000);
  // The original loop retains about 56 MiB of heap and 55 MiB of audio here.
  expect(active.heapMiB - baseline.heapMiB).toBeLessThan(16);
  expect(active.arrayBuffersMiB - baseline.arrayBuffersMiB).toBeLessThan(8);
  expect(closed.heapMiB - baseline.heapMiB).toBeLessThan(16);
}, 45000);
