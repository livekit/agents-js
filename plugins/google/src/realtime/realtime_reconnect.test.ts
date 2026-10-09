// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveCallbacks, LiveServerMessage, Session } from '@google/genai';
import { Live } from '@google/genai';
import { DEFAULT_API_CONNECT_OPTIONS, llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel, type RealtimeSession } from './realtime_api.js';

type Close = { code: number; reason: string };

/**
 * What the fake server does with a connect: confirm the setup, refuse it by
 * closing first, or confirm it and then send `messages` and close.
 */
type Plan =
  | 'live'
  | { refuse: Close }
  | { drop: Close; messages?: Array<Partial<LiveServerMessage>> };

type FakeSocket = { callbacks: LiveCallbacks; sent: unknown[]; closed: boolean };

const INTERNAL_ERROR: Close = { code: 1011, reason: 'Internal error encountered.' };
const QUOTA: Close = { code: 1011, reason: 'You exceeded your current quota.' };
const CONTEXT_EXHAUSTED: Close = { code: 1007, reason: 'Request contains an invalid argument.' };

/**
 * Stands in for the SDK's Live.connect: like the SDK, it resolves once the
 * server confirms the setup and never settles when the socket closes first.
 */
function fakeServer(plans: Plan[]) {
  const sockets: FakeSocket[] = [];
  const connect = vi
    .spyOn(Live.prototype, 'connect')
    .mockImplementation(async ({ callbacks }: { callbacks: LiveCallbacks }) => {
      const socket: FakeSocket = { callbacks, sent: [], closed: false };
      sockets.push(socket);
      const plan = plans[sockets.length - 1] ?? 'live';
      callbacks.onopen?.();
      if (plan !== 'live' && 'refuse' in plan) {
        setTimeout(() => callbacks.onclose?.(plan.refuse as CloseEvent), 5);
        return new Promise<Session>(() => {});
      }

      if (plan !== 'live') {
        setTimeout(() => {
          for (const message of plan.messages ?? []) {
            callbacks.onmessage(message as LiveServerMessage);
          }
          dropSocket({ socket, close: plan.drop });
        }, 20);
      }
      const send = (payload: unknown): void => {
        if (!socket.closed) socket.sent.push(payload);
      };
      return {
        sendClientContent: send,
        sendRealtimeInput: send,
        sendToolResponse: send,
        close: () => {
          socket.closed = true;
        },
      } as unknown as Session;
    });
  return { sockets, connect };
}

function dropSocket({ socket, close }: { socket: FakeSocket; close: Close }): void {
  socket.closed = true;
  socket.callbacks.onclose?.(close as CloseEvent);
}

function openSession(maxRetry = 2): {
  session: RealtimeSession;
  errors: llm.RealtimeModelError[];
} {
  const model = new RealtimeModel({
    model: 'gemini-3.8-live',
    apiKey: 'fake-key',
    connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry, retryIntervalMs: 10 },
  });
  const session = model.session();
  const errors: llm.RealtimeModelError[] = [];
  session.on('error', (error: llm.RealtimeModelError) => errors.push(error));
  return { session, errors };
}

describe('Google Realtime dropped connections', () => {
  let session: RealtimeSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.restoreAllMocks();
  });

  it('reconnects after the server drops a live session, replaying the chat context', async () => {
    const { sockets, connect } = fakeServer(['live', 'live']);
    const opened = openSession();
    session = opened.session;
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'My favourite number is 7351.' });
    await session.updateChatCtx(ctx);

    dropSocket({ socket: sockets[0]!, close: INTERNAL_ERROR });

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(JSON.stringify(sockets[1]!.sent)).toContain('7351'));
    expect(opened.errors.map((error) => error.recoverable)).toEqual([true]);
  });

  it('ends the session when the context is exhausted', async () => {
    const { sockets, connect } = fakeServer(['live', 'live']);
    const opened = openSession();
    session = opened.session;
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    dropSocket({ socket: sockets[0]!, close: CONTEXT_EXHAUSTED });

    await vi.waitFor(() => expect(opened.errors).toHaveLength(1));
    expect(opened.errors[0]!.recoverable).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('retries a setup the server refuses instead of hanging', async () => {
    const { sockets, connect } = fakeServer([{ refuse: QUOTA }, 'live']);
    const opened = openSession();
    session = opened.session;

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(sockets[1]!.closed).toBe(false);
    expect(opened.errors.map((error) => error.recoverable)).toEqual([true]);
  });

  it('retries a setup the server closes normally instead of hanging', async () => {
    const { connect } = fakeServer([{ refuse: { code: 1000, reason: '' } }, 'live']);
    const opened = openSession();
    session = opened.session;

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(opened.errors.map((error) => error.recoverable)).toEqual([true]);
  });

  it('gives up once retries run out, without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const refuse = { refuse: QUOTA };
      const { connect } = fakeServer([refuse, refuse, refuse, refuse]);
      const opened = openSession(2);
      session = opened.session;

      await vi.waitFor(() => expect(opened.errors).toHaveLength(3));
      expect(opened.errors.map((error) => error.recoverable)).toEqual([true, true, false]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(connect).toHaveBeenCalledTimes(3);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('runs out of retries when every fresh socket only sends a resumption update', async () => {
    const drop: Plan = {
      drop: QUOTA,
      messages: [{ sessionResumptionUpdate: { resumable: true, newHandle: 'handle' } }],
    };
    const { connect } = fakeServer([drop, drop, drop, drop, drop]);
    const opened = openSession(2);
    session = opened.session;

    await vi.waitFor(() => expect(opened.errors.at(-1)?.recoverable).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('ignores a late close of a socket it already replaced', async () => {
    const { sockets, connect } = fakeServer(['live', 'live']);
    const opened = openSession();
    session = opened.session;
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    dropSocket({ socket: sockets[0]!, close: INTERNAL_ERROR });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));

    sockets[0]!.callbacks.onclose?.(INTERNAL_ERROR as CloseEvent);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(connect).toHaveBeenCalledTimes(2);
    expect(opened.errors).toHaveLength(1);
  });

  it('keeps a late close of a replaced socket from ending the reply on the new one', async () => {
    const { sockets, connect } = fakeServer(['live', 'live']);
    const opened = openSession();
    session = opened.session;
    const internals = session as unknown as { currentGeneration?: { _done: boolean } };
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    dropSocket({ socket: sockets[0]!, close: INTERNAL_ERROR });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));

    sockets[1]!.callbacks.onmessage({
      serverContent: { modelTurn: { parts: [{ text: 'Seven three five one.' }] } },
    } as LiveServerMessage);
    await vi.waitFor(() => expect(internals.currentGeneration?._done).toBe(false));
    sockets[0]!.callbacks.onclose?.({ code: 1000, reason: '' } as CloseEvent);

    expect(internals.currentGeneration?._done).toBe(false);
  });

  it('finishes the reply in flight when a planned restart replaces the socket', async () => {
    const { sockets, connect } = fakeServer(['live', 'live']);
    const opened = openSession();
    session = opened.session;
    const internals = session as unknown as {
      currentGeneration?: { _done: boolean };
      markRestartNeeded(): void;
    };
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    sockets[0]!.callbacks.onmessage({
      serverContent: { modelTurn: { parts: [{ text: 'Seven three' }] } },
    } as LiveServerMessage);
    await vi.waitFor(() => expect(internals.currentGeneration?._done).toBe(false));
    const reply = internals.currentGeneration!;

    // As updateTools() does; the old socket never reports its close.
    internals.markRestartNeeded();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));

    expect(reply._done).toBe(true);
  });
});
