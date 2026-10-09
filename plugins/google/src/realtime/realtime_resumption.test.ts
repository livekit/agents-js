// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  LiveCallbacks,
  LiveConnectParameters,
  LiveServerMessage,
  Session,
} from '@google/genai';
import { Live } from '@google/genai';
import { llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RealtimeModel, type RealtimeSession } from './realtime_api.js';

type Connect = { callbacks: LiveCallbacks; config?: LiveConnectParameters['config'] };

/** Stands in for the SDK's Live.connect: every setup is confirmed. */
function fakeServer() {
  const connects: Connect[] = [];
  const connect = vi
    .spyOn(Live.prototype, 'connect')
    .mockImplementation(async ({ callbacks, config }: Connect) => {
      connects.push({ callbacks, config });
      callbacks.onopen?.();
      const noop = (): void => {};
      return {
        sendClientContent: noop,
        sendRealtimeInput: noop,
        sendToolResponse: noop,
        close: noop,
      } as unknown as Session;
    });
  return { connect, connects };
}

const getWeather = llm.tool({
  description: 'Get the weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: async () => 'sunny',
});

/** Hands the session a resumption handle, then forces a reconnect. */
async function reconnectAfterHandle({
  session,
  connect,
  connects,
}: {
  session: RealtimeSession;
  connect: ReturnType<typeof fakeServer>['connect'];
  connects: Connect[];
}): Promise<void> {
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(session['activeSession']).toBeDefined());
  connects[0]!.callbacks.onmessage({
    sessionResumptionUpdate: { newHandle: 'handle-1', resumable: true },
  } as LiveServerMessage);
  // The handler takes the session lock before it reads the message.
  await new Promise((resolve) => setTimeout(resolve, 20));

  await session.updateTools(new llm.ToolContext({ getWeather }));
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
}

describe('Google Realtime session resumption', () => {
  let session: RealtimeSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.restoreAllMocks();
  });

  it('resumes with the last handle by default', async () => {
    const { connect, connects } = fakeServer();
    session = new RealtimeModel({ model: 'gemini-3.8-live', apiKey: 'fake-key' }).session();

    await reconnectAfterHandle({ session, connect, connects });

    expect(connects[0]!.config?.sessionResumption).toEqual({});
    expect(connects[1]!.config?.sessionResumption).toEqual({ handle: 'handle-1' });
  });

  it('reconnects without a handle when session resumption is off', async () => {
    const { connect, connects } = fakeServer();
    session = new RealtimeModel({
      model: 'gemini-3.8-live',
      apiKey: 'fake-key',
      sessionResumption: false,
    }).session();

    await reconnectAfterHandle({ session, connect, connects });

    expect(connects[0]!.config?.sessionResumption).toBeUndefined();
    expect(connects[1]!.config?.sessionResumption).toBeUndefined();
  });
});
