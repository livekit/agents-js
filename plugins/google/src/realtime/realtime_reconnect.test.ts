// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveCallbacks, LiveServerMessage, Session } from '@google/genai';
import { Live } from '@google/genai';
import { APIConnectionError, DEFAULT_API_CONNECT_OPTIONS, llm, voice } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientEvents } from './api_proto.js';
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
  const sessions: Session[] = [];
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
      const session = {
        sendClientContent: send,
        sendRealtimeInput: send,
        sendToolResponse: send,
        close: () => {
          socket.closed = true;
        },
      } as unknown as Session;
      sessions.push(session);
      return session;
    });
  return { sockets, sessions, connect };
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
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe.each([0, 2])('task failures with maxRetry=%i', (maxRetry) => {
    it.each(['send throw', 'send rejection', 'receive handler'] as const)(
      'applies the retry budget and delay to a %s failure',
      async (source) => {
        vi.useFakeTimers();
        const { sockets, sessions, connect } = fakeServer([]);
        const opened = openSession(maxRetry);
        session = opened.session;
        const failure = new Error(`${source} failed`);
        const internals = session as unknown as {
          sendClientEvent(event: ClientEvents): void;
          handleServerContent(): void;
        };
        if (source === 'receive handler') {
          vi.spyOn(internals, 'handleServerContent').mockImplementation(() => {
            throw failure;
          });
        }
        await vi.advanceTimersByTimeAsync(0);

        for (let attempt = 0; attempt <= maxRetry; attempt++) {
          if (source === 'receive handler') {
            sockets[attempt]!.callbacks.onmessage({
              serverContent: { turnComplete: true },
            } as LiveServerMessage);
          } else {
            const sdkSession = sessions[attempt]! as unknown as {
              sendRealtimeInput(): void | Promise<void>;
            };
            vi.spyOn(sdkSession, 'sendRealtimeInput').mockImplementation(() => {
              if (source === 'send rejection') return Promise.reject(failure);
              throw failure;
            });
            internals.sendClientEvent({ type: 'realtime_input', value: { text: 'Hello' } });
          }
          await vi.advanceTimersByTimeAsync(0);

          expect(opened.errors).toHaveLength(attempt + 1);
          expect(opened.errors[attempt]!.error).toBe(failure);
          expect(opened.errors[attempt]!.recoverable).toBe(attempt < maxRetry);
          expect(connect).toHaveBeenCalledTimes(attempt + 1);

          if (attempt < maxRetry) {
            await vi.advanceTimersByTimeAsync(9);
            expect(connect).toHaveBeenCalledTimes(attempt + 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(connect).toHaveBeenCalledTimes(attempt + 2);
            expect(sockets[attempt]!.closed).toBe(true);
          }
        }

        await vi.advanceTimersByTimeAsync(100);
        expect(connect).toHaveBeenCalledTimes(maxRetry + 1);
        expect(opened.errors).toHaveLength(maxRetry + 1);
        expect(sockets.every((socket) => socket.closed)).toBe(true);
      },
    );
  });

  it.each(['send', 'receive'] as const)(
    'normalizes a non-Error %s failure without losing its cause',
    async (source) => {
      vi.useFakeTimers();
      const { sockets, sessions } = fakeServer([]);
      const opened = openSession(0);
      session = opened.session;
      await vi.advanceTimersByTimeAsync(0);
      const failure = 'provider failed';
      const internals = session as unknown as {
        sendClientEvent(event: ClientEvents): void;
        handleServerContent(): void;
      };
      if (source === 'send') {
        vi.spyOn(sessions[0]!, 'sendRealtimeInput').mockImplementation(() => {
          throw failure;
        });
        internals.sendClientEvent({ type: 'realtime_input', value: { text: 'Hello' } });
      } else {
        vi.spyOn(internals, 'handleServerContent').mockImplementation(() => {
          throw failure;
        });
        sockets[0]!.callbacks.onmessage({
          serverContent: { turnComplete: true },
        } as LiveServerMessage);
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(opened.errors).toHaveLength(1);
      expect(opened.errors[0]!.recoverable).toBe(false);
      expect(opened.errors[0]!.error).toBeInstanceOf(Error);
      expect(opened.errors[0]!.error.message).toBe(failure);
      expect(opened.errors[0]!.error.cause).toBe(failure);
    },
  );

  it.each(['send', 'receive'] as const)(
    'closes the AgentSession after a terminal %s failure',
    async (source) => {
      const { sockets, sessions, connect } = fakeServer([]);
      const model = new RealtimeModel({
        apiKey: 'fake-key',
        connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
      });
      const createSession = vi.spyOn(model, 'session');
      const agentSession = new voice.AgentSession({
        llm: model,
        vad: null,
        turnHandling: { turnDetection: 'manual' },
      });
      const error = vi.fn();
      const close = vi.fn();
      agentSession.on(voice.AgentSessionEventTypes.Error, error);
      agentSession.on(voice.AgentSessionEventTypes.Close, close);
      try {
        await agentSession.start({ agent: new voice.Agent({ instructions: 'Be helpful.' }) });
        await vi.waitFor(() => expect(sockets.at(-1)?.closed).toBe(false));
        session = createSession.mock.results[0]!.value as RealtimeSession;
        const internals = session as unknown as {
          sendClientEvent(event: ClientEvents): void;
          handleServerContent(): void;
        };
        const failure = new Error(`${source} failed`);
        const connectionCount = connect.mock.calls.length;
        if (source === 'send') {
          const sdkSession = sessions.at(-1)! as unknown as {
            sendRealtimeInput(): void | Promise<void>;
          };
          vi.spyOn(sdkSession, 'sendRealtimeInput').mockImplementation(() =>
            Promise.reject(failure),
          );
          internals.sendClientEvent({ type: 'realtime_input', value: { text: 'Hello' } });
        } else {
          vi.spyOn(internals, 'handleServerContent').mockImplementation(() => {
            throw failure;
          });
          sockets
            .at(-1)!
            .callbacks.onmessage({ serverContent: { turnComplete: true } } as LiveServerMessage);
        }

        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        expect(error).toHaveBeenCalledOnce();
        expect(error.mock.calls[0]![0].error).toMatchObject({ error: failure, recoverable: false });
        expect(connect).toHaveBeenCalledTimes(connectionCount);
        expect(sockets.every((socket) => socket.closed)).toBe(true);
      } finally {
        await agentSession.close();
      }
    },
  );

  it.each([0, 2])(
    'honors the retry budget and delay when an error precedes a late close (maxRetry=%i)',
    async (maxRetry) => {
      vi.useFakeTimers();
      const { sockets, connect } = fakeServer([]);
      const opened = openSession(maxRetry);
      session = opened.session;
      await vi.advanceTimersByTimeAsync(0);

      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        const socket = sockets[attempt]!;
        socket.callbacks.onerror?.({ message: 'Connection reset' } as ErrorEvent);
        await vi.advanceTimersByTimeAsync(0);

        expect(connect).toHaveBeenCalledTimes(attempt + 1);
        expect(opened.errors).toHaveLength(attempt + 1);
        expect(opened.errors[attempt]!.recoverable).toBe(attempt < maxRetry);
        expect(opened.errors[attempt]!.error).toBeInstanceOf(APIConnectionError);
        expect(opened.errors[attempt]!.error.message).toBe('Connection reset');

        if (attempt < maxRetry) {
          await vi.advanceTimersByTimeAsync(9);
          expect(connect).toHaveBeenCalledTimes(attempt + 1);
          await vi.advanceTimersByTimeAsync(1);
          expect(connect).toHaveBeenCalledTimes(attempt + 2);
        }

        // The transport's close event can arrive after its replacement is live.
        dropSocket({ socket, close: { code: 1006, reason: '' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(opened.errors).toHaveLength(attempt + 1);
      }

      await vi.advanceTimersByTimeAsync(100);
      expect(connect).toHaveBeenCalledTimes(maxRetry + 1);
      expect(sockets.at(-1)!.closed).toBe(true);
    },
  );

  it('ignores a transport error from a socket replaced by a config update', async () => {
    vi.useFakeTimers();
    const { sockets, connect } = fakeServer([]);
    const opened = openSession();
    session = opened.session;
    await vi.advanceTimersByTimeAsync(0);

    session.updateOptions({ temperature: 0.5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);

    sockets[0]!.callbacks.onerror?.({ message: 'Late transport error' } as ErrorEvent);
    await vi.advanceTimersByTimeAsync(100);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(opened.errors).toEqual([]);
    expect(sockets[1]!.closed).toBe(false);
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

  it('ends the session at once when the connect config cannot be built', async () => {
    const { sockets, connect } = fakeServer(['live', 'live']);
    const opened = openSession();
    session = opened.session;
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const bad = llm.tool({
      name: 'bad',
      description: 'd',
      parameters: {
        type: 'object',
        properties: { a: { type: 'string', minLength: 'many' } },
      } as never,
      execute: async () => {},
    });

    await session.updateTools(new llm.ToolContext([bad]));

    await vi.waitFor(() => expect(opened.errors).toHaveLength(1));
    expect(opened.errors[0]!.recoverable).toBe(false);
    expect(opened.errors[0]!.error.message).toContain('tool bad');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened.errors).toHaveLength(1);
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
