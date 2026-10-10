// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveCallbacks, LiveServerGoAway, Session } from '@google/genai';
import { FunctionResponseScheduling, Live } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel, type RealtimeSession } from './realtime_api.js';

/**
 * The session members the goAway restart reads, reached past `private`.
 */
type GoAwayInternals = {
  activeSession?: Session;
  awaitingToolReply: boolean;
  inUserActivity: boolean;
  handleGoAway(goAway: LiveServerGoAway): void;
  markRestartNeeded(): void;
  sendClientEvent(event: unknown): void;
};

const fakeSocket = (): Session =>
  ({
    sendClientContent: () => {},
    sendRealtimeInput: () => {},
    sendToolResponse: () => {},
    close: () => {},
  }) as unknown as Session;

/**
 * A session whose Live.connect behaves like the SDK's against a server that
 * confirms every setup.
 */
async function openSession(): Promise<{
  session: RealtimeSession;
  internals: GoAwayInternals;
  restarts: () => number;
}> {
  const connect = vi
    .spyOn(Live.prototype, 'connect')
    .mockImplementation(async ({ callbacks }: { callbacks: LiveCallbacks }) => {
      callbacks.onopen?.();
      return fakeSocket();
    });
  const session = new RealtimeModel({ model: 'gemini-3.8-live', apiKey: 'fake-key' }).session();
  const internals = session as unknown as GoAwayInternals;
  await vi.waitFor(() => expect(internals.activeSession).toBeDefined());
  // A restart closes the socket and connects again at once.
  return { session, internals, restarts: () => connect.mock.calls.length - 1 };
}

describe('Google Realtime goAway restart', () => {
  let session: RealtimeSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.restoreAllMocks();
  });

  it('restarts at once when nothing is in flight', async () => {
    const opened = await openSession();
    session = opened.session;

    opened.internals.handleGoAway({ timeLeft: '60s' });

    await vi.waitFor(() => expect(opened.restarts()).toBe(1));
  });

  it('waits for the reply to a blocking tool result', async () => {
    const opened = await openSession();
    session = opened.session;
    opened.internals.awaitingToolReply = true;

    opened.internals.handleGoAway({ timeLeft: '60s' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(opened.restarts()).toBe(0);

    opened.internals.awaitingToolReply = false;
    await vi.waitFor(() => expect(opened.restarts()).toBe(1));
  });

  it('leaves a connection that replaced the one that got the notice alone', async () => {
    const opened = await openSession();
    session = opened.session;
    opened.internals.inUserActivity = true;
    opened.internals.handleGoAway({ timeLeft: '60s' });

    // A config update, such as updateTools(), reconnects first.
    opened.internals.markRestartNeeded();
    await vi.waitFor(() => expect(opened.restarts()).toBe(1));
    opened.internals.inUserActivity = false;
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(opened.restarts()).toBe(1);
  });

  it('restarts at the deadline when the turn never ends', async () => {
    const opened = await openSession();
    session = opened.session;
    opened.internals.inUserActivity = true;

    // 10.3 s left minus the 10 s margin.
    opened.internals.handleGoAway({ timeLeft: '10.3s' });
    expect(opened.restarts()).toBe(0);

    await vi.waitFor(() => expect(opened.restarts()).toBe(1), { timeout: 2_000 });
  });

  it.each([
    [FunctionResponseScheduling.WHEN_IDLE, true],
    [FunctionResponseScheduling.SILENT, false],
  ])('after a blocking %s tool result, waits for a reply: %s', async (scheduling, waits) => {
    const opened = await openSession();
    session = opened.session;

    opened.internals.sendClientEvent({
      type: 'tool_response',
      value: {
        functionResponses: [{ id: 'call_1', name: 'lookup', response: {}, scheduling }],
      },
    });

    await vi.waitFor(() => expect(opened.internals.awaitingToolReply).toBe(waits));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened.internals.awaitingToolReply).toBe(waits);
  });
});
