// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { runApp } from './cli.js';
import { Future } from './utils.js';
import { ServerOptions } from './worker.js';

const mocks = vi.hoisted(() => ({ runConsole: vi.fn(), dispose: vi.fn(async () => {}) }));
vi.mock('./console.js', () => ({ runConsole: mocks.runConsole }));
vi.mock('@livekit/rtc-node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@livekit/rtc-node')>()),
  dispose: mocks.dispose,
}));
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(['resolve', 'reject'] as const)(
  'disposes native resources after console cleanup %s',
  async (ending) => {
    const closed = new Future<void>();
    const disposed = new Future<void>();
    mocks.runConsole.mockReturnValue(closed.await);
    mocks.dispose.mockImplementation(() => disposed.await);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.argv = ['node', 'test-agent.js', 'console', '--connect-addr', '127.0.0.1:1234'];
    runApp(new ServerOptions({ agent: 'test-agent.js' }));
    expect(mocks.runConsole).toHaveBeenCalledOnce();
    expect(mocks.dispose).not.toHaveBeenCalled();
    if (ending === 'resolve') closed.resolve();
    else closed.reject(new Error('console cleanup failed'));
    try {
      await vi.waitFor(() => expect(mocks.dispose).toHaveBeenCalledOnce());
      expect(exit).not.toHaveBeenCalled();
    } finally {
      disposed.resolve();
    }
    if (ending === 'reject') await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    else {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(exit).not.toHaveBeenCalled();
    }
  },
);
