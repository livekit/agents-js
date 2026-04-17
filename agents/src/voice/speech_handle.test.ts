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
import { functionCallStorage } from './agent.js';
import { SpeechHandle } from './speech_handle.js';

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
