// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { InferenceProcExecutor } from './inference_proc_executor.js';
import type { IPCMessage } from './message.js';

describe('InferenceProcExecutor', () => {
  it('fails pending and new requests once the inference process exits', async () => {
    type TestChild = EventEmitter & {
      connected: boolean;
      send: (message: IPCMessage) => boolean;
    };

    const child = new EventEmitter() as TestChild;
    child.connected = true;
    const sendSpy = vi.fn((message: IPCMessage) => {
      if (message.case === 'initializeRequest') {
        queueMicrotask(() =>
          child.emit('message', {
            case: 'initializeResponse',
            value: undefined,
          } satisfies IPCMessage),
        );
      }
      return true;
    });
    child.send = sendSpy;

    class TestExecutor extends InferenceProcExecutor {
      createProcess(): ChildProcess {
        return child as unknown as ChildProcess;
      }
    }

    const executor = new TestExecutor({
      runners: {},
      initializeTimeout: 100,
      closeTimeout: 20,
      memoryWarnMB: 0,
      memoryLimitMB: 0,
      pingInterval: 5000,
      pingTimeout: 60000,
      highPingThreshold: 2500,
    });
    await executor.start();
    await executor.initialize();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const pending = executor.doInference('test', {});
    child.connected = false;
    child.emit('disconnect');
    child.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('inference process exited');

    sendSpy.mockClear();
    await expect(executor.doInference('test', {})).rejects.toThrow('inference process not running');
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
