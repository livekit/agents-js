// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveCallbacks, LiveServerGoAway, Session } from '@google/genai';
import { FunctionResponseScheduling, Live, LiveServerMessage } from '@google/genai';
import { llm } from '@livekit/agents';
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
  onReceiveMessage(session: Session, message: LiveServerMessage): Promise<void>;
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
async function openSession(toolResponseScheduling?: FunctionResponseScheduling): Promise<{
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
  const session = new RealtimeModel({
    model: 'gemini-3.8-live',
    apiKey: 'fake-key',
    toolResponseScheduling,
  }).session();
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('restarts at once when nothing is in flight', async () => {
    const opened = await openSession();
    session = opened.session;

    opened.internals.handleGoAway({ timeLeft: '30.1s' });

    await vi.waitFor(() => expect(opened.restarts()).toBe(1));
  });

  it('waits for the last 30 s of the time the server grants', async () => {
    const opened = await openSession();
    session = opened.session;

    // 30.6 s left: the restart window opens in 0.6 s.
    opened.internals.handleGoAway({ timeLeft: '30.6s' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(opened.restarts()).toBe(0);

    await vi.waitFor(() => expect(opened.restarts()).toBe(1), { timeout: 2_000 });
  });

  it('waits for the reply to a blocking tool result', async () => {
    const opened = await openSession();
    session = opened.session;
    opened.internals.awaitingToolReply = true;

    opened.internals.handleGoAway({ timeLeft: '30.1s' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(opened.restarts()).toBe(0);

    opened.internals.awaitingToolReply = false;
    await vi.waitFor(() => expect(opened.restarts()).toBe(1));
  });

  it('leaves a connection that replaced the one that got the notice alone', async () => {
    const opened = await openSession();
    session = opened.session;
    opened.internals.inUserActivity = true;
    opened.internals.handleGoAway({ timeLeft: '30.1s' });

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
    FunctionResponseScheduling.WHEN_IDLE,
    FunctionResponseScheduling.SILENT,
    FunctionResponseScheduling.INTERRUPT,
  ])('defers restart until the blocking tool reply completes with %s', async (scheduling) => {
    const opened = await openSession(scheduling);
    session = opened.session;
    vi.useFakeTimers();
    const { internals } = opened;
    const socket = internals.activeSession!;
    const receive = (message: Partial<LiveServerMessage>) =>
      internals.onReceiveMessage(socket, Object.assign(new LiveServerMessage(), message));

    await receive({
      toolCall: { functionCalls: [{ id: 'call_1', name: 'lookup', args: {} }] },
    });
    await receive({ goAway: { timeLeft: '30s' } });
    const ctx = llm.ChatContext.empty();
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId: 'call_1',
        name: 'lookup',
        output: 'found',
        isError: false,
      }),
    );
    await session.updateChatCtx(ctx);

    await vi.advanceTimersByTimeAsync(250);
    expect(opened.restarts()).toBe(0);

    await receive({ serverContent: { modelTurn: { parts: [{ text: 'Result' }] } } });
    await vi.advanceTimersByTimeAsync(250);
    expect(opened.restarts()).toBe(0);

    await receive({ serverContent: { turnComplete: true } });
    await vi.advanceTimersByTimeAsync(250);
    expect(opened.restarts()).toBe(1);
  });
});
