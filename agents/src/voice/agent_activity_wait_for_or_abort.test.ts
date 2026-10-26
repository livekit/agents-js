// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * waitForOrAbort runs repeatedly on long-lived signals (waitForIdle on closeAbort.signal),
 * so it must not leave an abort listener behind once the awaited promise settles.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentActivity } from './agent_activity.js';

type WaitForOrAbort = (
  promise: Promise<void>,
  signal: AbortSignal,
  message: string,
) => Promise<void>;

function makeWait(): WaitForOrAbort {
  const activity = Object.create(AgentActivity.prototype) as AgentActivity;
  Object.assign(activity, { logger: { error: vi.fn() } });
  const wait = (activity as unknown as { waitForOrAbort: WaitForOrAbort }).waitForOrAbort;
  return wait.bind(activity);
}

function countAbortListeners(signal: AbortSignal): () => number {
  let count = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, ...rest: [EventListener, AddEventListenerOptions?]) => {
    if (type === 'abort') count++;
    add(type, ...rest);
  }) as AbortSignal['addEventListener'];
  signal.removeEventListener = ((type: string, ...rest: [EventListener]) => {
    if (type === 'abort') count--;
    remove(type, ...rest);
  }) as AbortSignal['removeEventListener'];
  return () => count;
}

describe('AgentActivity.waitForOrAbort', () => {
  it('removes its abort listener once the promise resolves', async () => {
    const wait = makeWait();
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);

    for (let i = 0; i < 20; i++) {
      await wait(Promise.resolve(), controller.signal, 'unused');
    }

    expect(listeners()).toBe(0);
  });

  it('removes its abort listener once the promise rejects', async () => {
    const wait = makeWait();
    const controller = new AbortController();
    const listeners = countAbortListeners(controller.signal);

    await wait(Promise.reject(new Error('boom')), controller.signal, 'unused');

    expect(listeners()).toBe(0);
  });

  it('returns when the signal aborts before the promise settles', async () => {
    const wait = makeWait();
    const controller = new AbortController();
    const pending = wait(new Promise<void>(() => {}), controller.signal, 'unused');

    controller.abort();

    await expect(pending).resolves.toBeUndefined();
  });
});
