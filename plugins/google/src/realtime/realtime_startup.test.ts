// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveCallbacks, LiveConnectParameters, Session } from '@google/genai';
import { Live } from '@google/genai';
import { llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RealtimeModel, type RealtimeSession } from './realtime_api.js';

/** Stands in for the SDK's Live.connect: every setup is confirmed. */
function fakeServer() {
  const setups: LiveConnectParameters['config'][] = [];
  const connect = vi
    .spyOn(Live.prototype, 'connect')
    .mockImplementation(
      async ({
        callbacks,
        config,
      }: {
        callbacks: LiveCallbacks;
        config?: LiveConnectParameters['config'];
      }) => {
        setups.push(config);
        callbacks.onopen?.();
        const noop = (): void => {};
        return {
          sendClientContent: noop,
          sendRealtimeInput: noop,
          sendToolResponse: noop,
          close: noop,
        } as unknown as Session;
      },
    );
  return { connect, setups };
}

const getWeather = llm.tool({
  description: 'Get the weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: async () => 'sunny',
});

describe('Google Realtime session startup', () => {
  let session: RealtimeSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.restoreAllMocks();
  });

  it('connects once when the framework configures the session right after creating it', async () => {
    const { connect, setups } = fakeServer();
    const model = new RealtimeModel({ model: 'gemini-3.8-live', apiKey: 'fake-key' });
    session = model.session();

    // What AgentActivity does right after creating the session.
    const chatCtx = llm.ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'Hello' });
    await session._updateSession(
      'You are a helpful tutor.',
      chatCtx,
      new llm.ToolContext({ getWeather }),
    );

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(setups[0]?.tools)).toContain('getWeather');
    expect(JSON.stringify(setups[0]?.systemInstruction)).toContain('You are a helpful tutor.');
  });

  it('still reconnects when the tools change after the first connect', async () => {
    const { connect, setups } = fakeServer();
    const model = new RealtimeModel({ model: 'gemini-3.8-live', apiKey: 'fake-key' });
    session = model.session();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session?.['activeSession']).toBeDefined());

    await session.updateTools(new llm.ToolContext({ getWeather }));

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(setups[1]?.tools)).toContain('getWeather');
  });
});
