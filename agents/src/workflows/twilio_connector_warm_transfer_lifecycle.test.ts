// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ConnectTwilioCallResponse } from '@livekit/protocol';
import { ParticipantKind, Room, RoomEvent, TrackKind } from '@livekit/rtc-node';
import { AccessToken, ConnectorClient } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContextAsync } from '../job.js';
import { log } from '../log.js';
import { Future } from '../utils.js';
import { Agent } from '../voice/agent.js';
import { AgentActivity } from '../voice/agent_activity.js';
import { AgentSession } from '../voice/agent_session.js';
import type { SpeechHandle } from '../voice/speech_handle.js';
import { createTwilioConnectorWarmTransferTask } from './warm_transfer.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(ringingTimeout = 5_000) {
  vi.stubEnv('LIVEKIT_API_KEY', 'api-key');
  vi.stubEnv('LIVEKIT_API_SECRET', 'api-secret');
  vi.spyOn(AccessToken.prototype, 'toJwt').mockResolvedValue('test-token');
  const connectedRooms: Room[] = [];
  vi.spyOn(Room.prototype, 'connect').mockImplementation(async function () {
    connectedRooms.push(this);
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
  const greeted = new Future<void>();
  const task = createTwilioConnectorWarmTransferTask({
    greetingSpeech: () => {
      greeted.resolve();
      return {} as SpeechHandle;
    },
    phoneNumber: '+15555550103',
    twilioFromNumber: '+15555550102',
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
  const answer = () => {
    const humanRoom = connectedRooms[0]!;
    const participant = {
      identity: 'human-agent-connector',
      trackPublications: new Map([['audio', { kind: TrackKind.KIND_AUDIO }]]),
    };
    humanRoom.remoteParticipants.set(participant.identity, participant as never);
    humanRoom.emit(RoomEvent.TrackPublished, {} as never, participant as never);
  };
  return {
    session,
    parent,
    task,
    outcome,
    controller,
    connect,
    fetch,
    disconnect,
    start,
    answer,
    greeted,
  };
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

  it('cleans up when answer and cancellation arrive in the same turn', async () => {
    const ctx = setup();
    ctx.connect.mockResolvedValue(
      new ConnectTwilioCallResponse({ connectUrl: 'wss://connector.example/stream' }),
    );
    try {
      await ctx.start();
      await vi.waitFor(() => expect(ctx.fetch).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
      ctx.answer();
      ctx.controller.abort(new Error('cancelled at answer'));
      expect(await ctx.outcome.await).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(ctx.fetch).toHaveBeenCalledTimes(2));
      expect(ctx.fetch.mock.calls[1]![1].body.get('Status')).toBe('completed');
    } finally {
      await ctx.session.close();
    }
  });

  it('keeps an answered call when the workflow finishes dialing', async () => {
    const ctx = setup();
    ctx.connect.mockResolvedValue(
      new ConnectTwilioCallResponse({ connectUrl: 'wss://connector.example/stream' }),
    );
    try {
      await ctx.start();
      await vi.waitFor(() => expect(ctx.fetch).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
      ctx.answer();
      await ctx.greeted.await;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ctx.fetch).toHaveBeenCalledOnce();
      expect(ctx.outcome.done).toBe(false);
    } finally {
      await ctx.session.close();
    }
  });

  it.each(['http', 'transport', 'deadline'] as const)(
    'preserves transfer failure when cleanup fails: %s',
    async (failure) => {
      const ctx = setup(10);
      const warn = vi.spyOn(log(), 'warn');
      const cleanupController = new AbortController();
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      const deadline = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((delay) =>
          delay === 10_000 ? cleanupController.signal : timeout(delay),
        );
      ctx.connect.mockResolvedValue(
        new ConnectTwilioCallResponse({ connectUrl: 'wss://connector.example/stream' }),
      );
      ctx.fetch
        .mockImplementationOnce(() => Promise.resolve(new Response('{"sid":"CA_test"}')))
        .mockImplementationOnce((_url, options) => {
          if (failure === 'http')
            return Promise.resolve(new Response('private provider payload', { status: 500 }));
          if (failure === 'transport')
            return Promise.reject(new Error('private transport details'));
          return new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            }),
          );
        });
      try {
        await ctx.start();
        expect(await ctx.outcome.await).toMatchObject({ message: 'could not dial human agent' });
        expect(ctx.session.currentAgent).toBe(ctx.parent);
        expect(deadline).toHaveBeenCalledWith(10_000);
        if (failure === 'deadline') cleanupController.abort(new Error('cleanup timed out'));
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
        expect(ctx.fetch).toHaveBeenCalledTimes(2);
      } finally {
        cleanupController.abort();
        await ctx.session.close();
      }
    },
  );
});
