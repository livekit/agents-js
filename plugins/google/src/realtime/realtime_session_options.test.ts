// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveCallbacks, LiveConnectParameters, Session } from '@google/genai';
import { Live } from '@google/genai';
import { DEFAULT_API_CONNECT_OPTIONS, llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel, type RealtimeSession } from './realtime_api.js';

type SessionInternals = { options: { instructions?: string; voice?: string } };

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

  it('keeps instructions and options per session', async () => {
    fakeServer();
    const model = new RealtimeModel({ apiKey: 'test-key', instructions: 'model default' });
    const first = open(model, { instructions: 'first agent' });
    const second = open(model);

    await first.updateInstructions('first agent, updated');
    first.updateOptions({ voice: 'Kore' });

    expect(model._options.instructions).toBe('model default');
    expect(model._options.voice).not.toBe('Kore');
    const secondOptions = (second as unknown as SessionInternals).options;
    expect(secondOptions.instructions).toBe('model default');
    expect(secondOptions.voice).toBe(model._options.voice);
  });

  it('forwards model option updates to open sessions', async () => {
    const connect = fakeServer();
    const model = new RealtimeModel({ apiKey: 'test-key' });
    const session = open(model);
    const closed = open(model);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await closed.close();

    model.updateOptions({ voice: 'Kore' });

    expect((session as unknown as SessionInternals).options.voice).toBe('Kore');
    expect((closed as unknown as SessionInternals).options.voice).not.toBe('Kore');
    // A new voice needs a new connection, as in the Python plugin.
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
  });

  it('stops forwarding model option updates after the connection loop ends', async () => {
    const connect = vi.spyOn(Live.prototype, 'connect').mockRejectedValue(new Error('refused'));
    const model = new RealtimeModel({
      apiKey: 'test-key',
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
    });
    const session = open(model);
    const errors: llm.RealtimeModelError[] = [];
    session.on('error', (error: llm.RealtimeModelError) => errors.push(error));
    await vi.waitFor(() => expect(errors.some((error) => !error.recoverable)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    model.updateOptions({ voice: 'Kore' });

    expect((session as unknown as SessionInternals).options.voice).not.toBe('Kore');
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
