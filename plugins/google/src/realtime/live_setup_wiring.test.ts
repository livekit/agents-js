// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as genai from '@google/genai';
import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeModel } from './realtime_api.js';

interface RecordingSocket {
  sent: string[];
  connect(): void;
  send(message: string): void;
  close(): void;
}

/**
 * Records every client the plugin builds so the test can reach the socket
 * factory that `RealtimeSession` patches. Hoisted because `vi.mock` is.
 */
const { clients, live } = vi.hoisted(() => ({
  clients: [] as Array<{
    live: { webSocketFactory: { create: () => unknown } };
  }>,
  /**
   * `gate` holds `connect()` open so a test can seed the chat context before the
   * main task reaches the prefill, the same order `AgentActivity` uses.
   */
  live: {
    gate: new Promise<void>(() => {}),
    prefill: [] as Array<{ turns: Array<{ role?: string }>; turnComplete?: boolean }>,
    realtime: [] as Array<{ text?: string }>,
  },
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof genai>();
  return {
    ...actual,
    GoogleGenAI: class {
      live = {
        webSocketFactory: {
          create: (): RecordingSocket => {
            const socket: RecordingSocket = {
              sent: [],
              connect: () => {},
              send: (message: string) => socket.sent.push(message),
              close: () => {},
            };
            return socket;
          },
        },
        connect: async ({ callbacks }: { callbacks: { onopen: () => void } }) => {
          callbacks.onopen();
          await live.gate;
          return {
            sendClientContent: (params: {
              turns: Array<{ role?: string }>;
              turnComplete?: boolean;
            }) => live.prefill.push(params),
            sendRealtimeInput: (params: { text?: string }) => live.realtime.push(params),
            sendToolResponse: () => {},
            close: () => {},
          };
        },
      };

      constructor() {
        clients.push(this as never);
      }
    },
  };
});

/**
 * Guards the wiring rather than the policy: that `RealtimeSession` installs the
 * hook on the client it will actually connect with, and does so from its
 * constructor.
 *
 * The constructor timing is the whole point. `AgentActivity` creates the session
 * and only seeds the chat context afterwards, so anything that defers this
 * decision until the context arrives silently stops seeding history.
 */
describe('RealtimeSession history config wiring', () => {
  function setupFrameFor(model: string) {
    clients.length = 0;
    new RealtimeModel({ model, apiKey: 'test-key' }).session();

    expect(clients).toHaveLength(1);
    const socket = clients[0]!.live.webSocketFactory.create() as RecordingSocket;
    socket.send(JSON.stringify({ setup: { model: `models/${model}` } }));

    return JSON.parse(socket.sent[0]!).setup;
  }

  it('patches the factory during construction, before any chat context exists', () => {
    expect(setupFrameFor('gemini-3.1-flash-live-preview').historyConfig).toEqual({
      initialHistoryInClientContent: true,
    });
  });

  it('leaves the factory alone for models that accept a plain prefill', () => {
    expect(setupFrameFor('gemini-2.0-flash-live-001').historyConfig).toBeUndefined();
  });
});

/**
 * Per https://ai.google.dev/api/live#HistoryConfig the seeded history never
 * triggers a model call and the conversation starts via realtimeInput, so a
 * trailing question left inside the history is silently absorbed unanswered.
 */
describe('seeding a chat context that ends on a user turn', () => {
  async function prefillFor(model: string) {
    live.prefill.length = 0;
    live.realtime.length = 0;
    let openGate = () => {};
    live.gate = new Promise<void>((resolve) => (openGate = resolve));

    const session = new RealtimeModel({ model, apiKey: 'test-key' }).session();
    const chatCtx = llm.ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'I am studying for a calculus exam.' });
    chatCtx.addMessage({ role: 'assistant', content: 'Which topic is giving you trouble?' });
    chatCtx.addMessage({ role: 'user', content: 'What are we working on?' });
    await session.updateChatCtx(chatCtx);

    openGate();
    return live.prefill;
  }

  it('closes the history phase, then asks as realtime text', async () => {
    const prefill = await prefillFor('gemini-3.1-flash-live-preview');
    await vi.waitFor(() => expect(live.realtime).toHaveLength(1));

    expect(prefill).toHaveLength(1);
    expect(prefill[0]!.turns.at(-1)?.role).toBe('model');
    expect(prefill[0]!.turnComplete).toBe(true);
    expect(live.realtime[0]!.text).toBe('What are we working on?');
  });

  it('sends one open frame for models that accept a plain prefill', async () => {
    const prefill = await prefillFor('gemini-2.0-flash-live-001');
    await vi.waitFor(() => expect(prefill).toHaveLength(1));

    expect(prefill[0]!.turns).toHaveLength(3);
    expect(prefill[0]!.turnComplete).toBe(false);
    expect(live.realtime).toHaveLength(0);
  });
});
