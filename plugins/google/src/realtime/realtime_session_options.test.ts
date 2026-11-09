// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveCallbacks, LiveConnectParameters, Session } from '@google/genai';
import { Live } from '@google/genai';
import { llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel, type RealtimeSession } from './realtime_api.js';

/** Stands in for the SDK's Live.connect against a server that confirms every setup. */
function fakeServer() {
  return vi
    .spyOn(Live.prototype, 'connect')
    .mockImplementation(async ({ callbacks }: { callbacks: LiveCallbacks }) => {
      callbacks.onopen?.();
      const send = (): void => {};
      return {
        sendClientContent: send,
        sendRealtimeInput: send,
        sendToolResponse: send,
        close: () => {},
      } as unknown as Session;
    });
}

const lookup = llm.tool({
  name: 'lookup',
  description: 'look something up',
  execute: async () => 'ok',
});

function initialConfig() {
  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({ role: 'user', content: 'hi there' });
  return { instructions: 'be brief', chatCtx, tools: new llm.ToolContext([lookup]) };
}

describe('Google Realtime initial session options', () => {
  const sessions: RealtimeSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    vi.restoreAllMocks();
  });

  function open(model: RealtimeModel, options?: llm.RealtimeSessionOptions): RealtimeSession {
    const session = model.session(options);
    sessions.push(session);
    return session;
  }

  it('connects once with the seeded config when the framework applies it again', async () => {
    const connect = fakeServer();
    const config = initialConfig();
    const session = open(new RealtimeModel({ apiKey: 'test-key' }), config);

    // AgentActivity applies the same values right after it creates the session.
    await session._updateSession(config.instructions, config.chatCtx, config.tools.copy());
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(connect).toHaveBeenCalledTimes(1);
    const params = connect.mock.calls[0]![0] as LiveConnectParameters;
    expect(params.config?.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] });
    expect(JSON.stringify(params.config?.tools)).toContain('lookup');
    expect(session.tools.equals(config.tools)).toBe(true);
    expect(session.chatCtx.items.map((item) => item.id)).toEqual(
      config.chatCtx.items.map((item) => item.id),
    );
  });

  it('reconnects when the config arrives only after the session is created', async () => {
    const connect = fakeServer();
    const config = initialConfig();
    const session = open(new RealtimeModel({ apiKey: 'test-key' }));

    await session._updateSession(config.instructions, config.chatCtx, config.tools);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  });
});
