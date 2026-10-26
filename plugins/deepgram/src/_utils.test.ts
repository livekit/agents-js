// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

describe('abandoned queue reads', () => {
  // The send loops hand `input.next()` an AbortSignal and cancel it when an attempt
  // ends. This pins why: an abandoned read stays parked inside the queue and shifts
  // the next frame off it for a promise nobody awaits, so a sender left over from a
  // previous attempt silently steals audio from the current one.
  const tick = () => new Promise((r) => setImmediate(r));

  it('steals the next item when the read is merely raced away', async () => {
    const { AsyncIterableQueue } = await import('@livekit/agents');
    const queue = new AsyncIterableQueue<string>();

    void queue.next(); // the previous attempt's sender, abandoned by a Promise.race
    await tick();

    let received: string | undefined;
    void queue.next().then((r) => {
      received = r.value;
    });
    await tick();

    queue.put('frame');
    await tick();

    expect(received).toBeUndefined(); // the abandoned read took it
  });

  it('leaves the next item alone when the read is cancelled', async () => {
    const { AsyncIterableQueue } = await import('@livekit/agents');
    const queue = new AsyncIterableQueue<string>();

    const attempt = new AbortController();
    void queue.next({ signal: attempt.signal }).catch(() => {});
    await tick();
    attempt.abort();
    await tick();

    let received: string | undefined;
    void queue.next().then((r) => {
      received = r.value;
    });
    await tick();

    queue.put('frame');
    await tick();

    expect(received).toBe('frame');
  });
});
