// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Regression tests for the tool-call deadlock fix.
//
// Previously, SpeechHandle.waitForPlayout() threw whenever any function tool
// was on the async stack, even when the awaited handle was a different one
// scheduled inside the tool. Fix: narrow the throw to the owning SpeechHandle
// only, and make SpeechHandle itself awaitable.
import { describe, expect, it, vi } from 'vitest';
import { FunctionCall } from '../llm/chat_context.js';
import { Task, waitForAbort } from '../utils.js';
import { functionCallStorage } from './agent.js';
import { REPLY_TASK_CANCEL_TIMEOUT, SpeechHandle } from './speech_handle.js';

async function raceTimeout(promise: Promise<unknown>, ms: number): Promise<'resolved' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise.then(() => 'resolved' as const), timeout]).finally(() =>
    clearTimeout(timer!),
  );
}

function makeFunctionCall(): FunctionCall {
  return FunctionCall.create({
    callId: 'call_test',
    name: 'test_tool',
    args: '{}',
  });
}

describe('SpeechHandle.waitForPlayout - tool-context owner check', () => {
  it('throws only when called on the SpeechHandle that owns the active tool', async () => {
    const owningHandle = SpeechHandle.create();
    const functionCall = makeFunctionCall();

    // Simulate: we're inside a function tool owned by `owningHandle`.
    await functionCallStorage.run({ functionCall, speechHandle: owningHandle }, async () => {
      await expect(owningHandle.waitForPlayout()).rejects.toThrow(/circular wait/);
    });
  });

  it('does NOT throw when awaiting a different handle from inside a tool', async () => {
    const owningHandle = SpeechHandle.create();
    const otherHandle = SpeechHandle.create();
    const functionCall = makeFunctionCall();

    // Resolve otherHandle's playout shortly after we start waiting on it.
    setTimeout(() => otherHandle._markDone(), 10);

    await functionCallStorage.run({ functionCall, speechHandle: owningHandle }, async () => {
      // This used to throw; should now complete without deadlock.
      const outcome = await raceTimeout(otherHandle.waitForPlayout(), 1000);
      expect(outcome).toBe('resolved');
    });
  });

  it('does not throw when called outside any tool context', async () => {
    const handle = SpeechHandle.create();
    setTimeout(() => handle._markDone(), 10);

    const outcome = await raceTimeout(handle.waitForPlayout(), 1000);
    expect(outcome).toBe('resolved');
  });
});

describe('SpeechHandle - awaitable protocol', () => {
  it('resolves `await handle` to the handle itself', async () => {
    const handle = SpeechHandle.create();
    setTimeout(() => handle._markDone(), 10);

    const result = await handle;

    expect(result).toBe(handle);
  });

  it('restores the prototype .then after awaiting (direct .then still works)', async () => {
    const handle = SpeechHandle.create();
    handle._markDone();

    await handle;

    // No own `then` property left behind — the shadow was cleaned up.
    expect(Object.hasOwn(handle, 'then')).toBe(false);
    expect(typeof handle.then).toBe('function');

    // A direct .then(cb) call must still work because the prototype is intact.
    const cb = vi.fn();
    await handle.then(cb);
    expect(cb).toHaveBeenCalledWith(handle);
  });

  it('supports multiple concurrent awaits of the same handle', async () => {
    const handle = SpeechHandle.create();
    setTimeout(() => handle._markDone(), 10);

    const [a, b, c] = await Promise.all([handle, handle, handle]);
    expect(a).toBe(handle);
    expect(b).toBe(handle);
    expect(c).toBe(handle);
  });

  it('supports re-awaiting after playout has completed', async () => {
    const handle = SpeechHandle.create();
    handle._markDone();

    // First await: goes through waitForPlayout, then the shadow/delete dance.
    const first = await handle;
    expect(first).toBe(handle);

    // Second await after playout finished: waitForPlayout resolves immediately,
    // shadow/delete repeats, should resolve to handle again (idempotent).
    const second = await handle;
    expect(second).toBe(handle);
  });
});

describe('SpeechHandle - simulated tool-call deadlock scenario', () => {
  // Models the previously-broken pattern:
  //
  //   1. Speech A is running; its tool handler executes.
  //   2. Inside the tool, user code does
  //      `await session.generateReply().waitForPlayout()`, which creates Speech B.
  //   3. Speech B eventually completes; the tool resumes and finishes.
  //
  // Before the fix, step 2 threw synchronously. This test proves that the
  // await-on-child-handle path runs to completion and does so without hanging
  // past a reasonable timeout.
  it('tool handler can await a child SpeechHandle without deadlocking', async () => {
    const parentHandle = SpeechHandle.create();
    const functionCall = makeFunctionCall();

    // Background "speech queue" resolves the child handle after a short delay,
    // standing in for the real mainTask dequeueing and playing it out.
    const runTool = async () =>
      functionCallStorage.run({ functionCall, speechHandle: parentHandle }, async () => {
        const childHandle = SpeechHandle.create();
        setTimeout(() => childHandle._markDone(), 20);

        await childHandle.waitForPlayout();
        return 'tool-complete';
      });

    const outcome = await raceTimeout(runTool(), 2000);
    expect(outcome).toBe('resolved');

    // Parent handle itself is unchanged — we never marked it done.
    expect(parentHandle.done()).toBe(false);
  });

  it('tool handler can `await childHandle` (awaitable form) without deadlocking', async () => {
    const parentHandle = SpeechHandle.create();
    const functionCall = makeFunctionCall();

    const runTool = async () =>
      functionCallStorage.run({ functionCall, speechHandle: parentHandle }, async () => {
        const childHandle = SpeechHandle.create();
        setTimeout(() => childHandle._markDone(), 20);

        // Awaitable form — same as `await session.generateReply()` end-to-end.
        const resolved = await childHandle;
        expect(resolved).toBe(childHandle);
        return 'tool-complete';
      });

    const outcome = await raceTimeout(runTool(), 2000);
    expect(outcome).toBe('resolved');
  });
});

describe('SpeechHandle._markDone - generation completion', () => {
  it('resolves an active generation even when the handle is already done', async () => {
    const handle = SpeechHandle.create();
    const internalHandle = handle as unknown as { doneFut: { resolve(value: void): void } };

    internalHandle.doneFut.resolve(undefined);
    handle._authorizeGeneration();

    const generationWait = handle._waitForGeneration();
    handle._markDone();

    const outcome = await raceTimeout(generationWait, 1000);
    expect(outcome).toBe('resolved');
  });
});

describe('SpeechHandle.interrupt - protected completed speech', () => {
  it('leaves an interrupted protected handle alone', () => {
    const handle = SpeechHandle.create({ allowInterruptions: false });
    handle.interrupt(true);

    expect(handle.interrupt()).toBe(handle);
    expect(handle.interrupted).toBe(true);
    handle._markDone();
  });

  it('leaves a done protected handle alone', () => {
    const handle = SpeechHandle.create({ allowInterruptions: false });
    handle._markDone();

    expect(handle.interrupt()).toBe(handle);
    expect(handle.interrupted).toBe(false);
  });
});

describe('SpeechHandle interruption watchdog (#2065)', () => {
  it('cancels the owned tasks and marks the handle done when an interrupt is ignored', async () => {
    vi.useFakeTimers();
    try {
      const handle = SpeechHandle.create();
      // A reply task that never observes its interruption — the shape of the #2065 hang,
      // where the only escape from the post-interrupt playout wait is this abort signal.
      const task = Task.from(
        (controller) =>
          new Promise<void>((resolve) => waitForAbort(controller.signal).then(resolve)),
      );
      handle._tasks.push(task);
      handle._authorizeGeneration();
      const generationWait = handle._waitForGeneration();

      handle.interrupt();
      expect(handle.done()).toBe(false);

      // A reply that unwinds slowly is allowed the whole cooperative-cancel budget before the
      // watchdog is entitled to act. Firing inside that window would cut off a teardown that is
      // still on its way to committing the turn.
      await vi.advanceTimersByTimeAsync(REPLY_TASK_CANCEL_TIMEOUT);
      expect(handle.done()).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(task.done).toBe(true);
      expect(handle.done()).toBe(true);
      // The scheduling loop's wait is released, so the next queued speech can be authorized.
      await expect(generationWait).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cancel a speech that finishes within the grace period', async () => {
    vi.useFakeTimers();
    try {
      const handle = SpeechHandle.create();
      const task = Task.from(() => Promise.resolve());
      const cancel = vi.spyOn(task, 'cancel');
      handle._tasks.push(task);

      handle.interrupt();
      handle._markDone();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SpeechHandle.exception', () => {
  it('throws when the handle is not done yet', () => {
    const handle = SpeechHandle.create();
    expect(() => handle.exception()).toThrow(/not done yet/);
  });

  it('returns undefined when the handle completed without an error', () => {
    const handle = SpeechHandle.create();
    handle._markDone();
    expect(handle.exception()).toBeUndefined();
  });

  it('returns the error passed to _markDone', () => {
    const handle = SpeechHandle.create();
    const error = new Error('realtime failed');
    handle._markDone(error);
    expect(handle.exception()).toBe(error);
  });
});
