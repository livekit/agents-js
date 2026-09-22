// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ConnectTwilioCallResponse } from '@livekit/protocol';
import { ParticipantKind, Room } from '@livekit/rtc-node';
import { AccessToken, ConnectorClient } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContextAsync } from '../job.js';
import { Future } from '../utils.js';
import { Agent } from '../voice/agent.js';
import { AgentActivity } from '../voice/agent_activity.js';
import { AgentSession } from '../voice/agent_session.js';
import { createTwilioConnectorWarmTransferTask } from './twilio_connector_warm_transfer.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(ringingTimeout = 5_000) {
  vi.stubEnv('LIVEKIT_API_KEY', 'api-key');
  vi.stubEnv('LIVEKIT_API_SECRET', 'api-secret');
  vi.spyOn(AccessToken.prototype, 'toJwt').mockResolvedValue('test-token');
  vi.spyOn(Room.prototype, 'connect').mockImplementation(async function () {
    Object.defineProperties(this, {
      name: { value: 'consult-room' },
      isConnected: { get: () => true },
      localParticipant: {
        value: { identity: 'transfer-agent', setAttributes: vi.fn().mockResolvedValue(undefined) },
      },
    });
  });
  const disconnect = vi.spyOn(Room.prototype, 'disconnect').mockResolvedValue();
  const callerRoom = new Room();
  Object.defineProperties(callerRoom, {
    name: { value: 'caller-room' },
    localParticipant: { value: { identity: 'transfer-agent' } },
  });
  callerRoom.remoteParticipants.set('caller', {
    identity: 'caller',
    kind: ParticipantKind.CONNECTOR,
  } as never);
  const ctx = {
    job: {},
    room: callerRoom,
    simulationContext: () => undefined,
    info: { url: 'wss://example.livekit.cloud', apiKey: 'api-key', apiSecret: 'api-secret' },
    deleteRoom: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobContext;
  const connect = vi.spyOn(ConnectorClient.prototype, 'connectTwilioCall');
  const fetch = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response('{"sid":"CA_late"}')));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const task = createTwilioConnectorWarmTransferTask({
    phoneNumber: '+15555550103',
    twilioFromNumber: '+15555550102',
    originalCallerNumber: '+15555550101',
    twilioCallToken: 'test-call-token',
    twilioAccountSid: 'AC_test',
    twilioAuthToken: 'test-auth',
    abortSignal: controller.signal,
    ringingTimeout,
    holdAudio: null,
    turnDetection: 'manual',
  });
  const outcome = new Future<unknown>();
  class CallerAgent extends Agent {
    override async onEnter() {
      try {
        outcome.resolve(await task.run());
      } catch (error) {
        outcome.resolve(error);
      }
    }
  }
  const parent = new CallerAgent({ instructions: 'Help the caller', turnDetection: 'manual' });
  const session = new AgentSession({ turnDetection: 'manual' });
  const start = () =>
    runWithJobContextAsync(ctx, () => session.start({ agent: parent, record: false }));
  return { session, parent, task, outcome, controller, connect, fetch, disconnect, start };
}

describe('Twilio warm transfer with real session and activity lifecycle', () => {
  it.each(['throw', 'reject'] as const)('resumes the caller after connector %s', async (mode) => {
    const ctx = setup();
    ctx.connect.mockImplementation(() => {
      const error = new Error('connector unavailable');
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    });
    try {
      await ctx.start();
      expect(await ctx.outcome.await).toMatchObject({ message: 'could not dial human agent' });
      expect(ctx.session.currentAgent).toBe(ctx.parent);
      expect(ctx.fetch).not.toHaveBeenCalled();
      expect(ctx.disconnect).toHaveBeenCalledOnce();
    } finally {
      ctx.controller.abort();
      await ctx.session.close();
    }
  });

  it('resumes the caller and closes the session while timeout cleanup is pending', async () => {
    const ctx = setup(10);
    const cleanup = new Future<Response>();
    ctx.connect.mockResolvedValue(
      new ConnectTwilioCallResponse({ connectUrl: 'wss://connector.example/stream' }),
    );
    ctx.fetch
      .mockResolvedValueOnce(new Response('{"sid":"CA_test"}'))
      .mockReturnValueOnce(cleanup.await);
    try {
      await ctx.start();
      expect(await ctx.outcome.await).toMatchObject({ message: 'could not dial human agent' });
      expect(ctx.session.currentAgent).toBe(ctx.parent);
      await ctx.session.close();
      expect(cleanup.done).toBe(false);
      expect(ctx.fetch).toHaveBeenCalledTimes(2);
    } finally {
      cleanup.resolve(new Response('{}'));
      ctx.controller.abort();
      await ctx.session.close();
    }
  });

  it('resumes the caller and closes the consultation when connector setup is aborted', async () => {
    const ctx = setup();
    const entered = new Future<void>();
    const response = new Future<ConnectTwilioCallResponse>();
    ctx.connect.mockImplementation(() => {
      entered.resolve();
      return response.await;
    });
    try {
      await ctx.start();
      await entered.await;
      expect(ctx.task._agentActivity).toBeInstanceOf(AgentActivity);
      const activity = ctx.task._agentActivity!;
      const reason = new Error('transfer cancelled');
      ctx.controller.abort(reason);
      expect(await ctx.outcome.await).toBe(reason);
      expect(ctx.session.currentAgent).toBe(ctx.parent);
      expect(ctx.session._activity).toBeInstanceOf(AgentActivity);
      expect(ctx.session._activity).not.toBe(activity);
      expect(ctx.disconnect).toHaveBeenCalledOnce();
      response.resolve(
        new ConnectTwilioCallResponse({ connectUrl: 'wss://connector.example/stream' }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ctx.fetch).not.toHaveBeenCalled();
    } finally {
      if (!response.done) response.resolve(new ConnectTwilioCallResponse());
      ctx.controller.abort();
      await ctx.session.close();
    }
  });

  it('allows session shutdown before a pending Twilio creation resolves and cancels the late call', async () => {
    const ctx = setup();
    const entered = new Future<void>();
    const response = new Future<Response>();
    ctx.connect.mockResolvedValue(
      new ConnectTwilioCallResponse({ connectUrl: 'wss://connector.example/stream' }),
    );
    ctx.fetch.mockImplementationOnce(() => {
      entered.resolve();
      return response.await;
    });
    try {
      await ctx.start();
      await entered.await;
      expect(ctx.task._agentActivity).toBeInstanceOf(AgentActivity);
      ctx.controller.abort(new Error('shutdown'));
      expect(await ctx.outcome.await).toBeInstanceOf(Error);
      await ctx.session.close();
      expect(response.done).toBe(false);
      expect(ctx.disconnect).toHaveBeenCalledOnce();
      response.resolve(new Response('{"sid":"CA_late"}'));
      await vi.waitFor(() => expect(ctx.fetch).toHaveBeenCalledTimes(2));
      expect(ctx.fetch.mock.calls[1]![0]).toContain('/Calls/CA_late.json');
      expect(Object.fromEntries(ctx.fetch.mock.calls[1]![1].body)).toEqual({ Status: 'completed' });
    } finally {
      if (!response.done) response.resolve(new Response('{"sid":"CA_late"}'));
      ctx.controller.abort();
      await ctx.session.close();
    }
  });
});
