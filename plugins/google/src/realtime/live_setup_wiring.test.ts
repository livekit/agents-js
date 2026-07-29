// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as genai from '@google/genai';
import { describe, expect, it, vi } from 'vitest';

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
const { clients } = vi.hoisted(() => ({
  clients: [] as Array<{
    live: { webSocketFactory: { create: () => unknown } };
  }>,
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
        // Parks the session's main task so nothing reaches the network.
        connect: () => new Promise<never>(() => {}),
      };

      constructor() {
        clients.push(this as never);
      }
    },
  };
});

const { RealtimeModel } = await import('./realtime_api.js');

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
