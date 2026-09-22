// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind, Room } from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContextAsync } from '../job.js';
import { Future } from '../utils.js';
import { Agent } from '../voice/agent.js';
import { AgentActivity } from '../voice/agent_activity.js';
import { AgentSession } from '../voice/agent_session.js';
import { type DialRecipient, createTransferTask } from './warm_transfer.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(dialRecipient: DialRecipient) {
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
  const sip = vi.spyOn(SipClient.prototype, 'createSipParticipant');
  const controller = new AbortController();
  const task = createTransferTask(
    { abortSignal: controller.signal, holdAudio: null, turnDetection: 'manual' },
    'transfer-recipient',
    dialRecipient,
  );
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
  return { session, parent, task, outcome, controller, sip, disconnect, start };
}

describe('internal recipient dialing with the real session lifecycle', () => {
  it('uses the dialed recipient for the move and the existing result field', async () => {
    const dialRecipient = vi.fn<DialRecipient>().mockResolvedValue();
    const ctx = setup(dialRecipient);
    const move = vi.spyOn(RoomServiceClient.prototype, 'moveParticipant').mockResolvedValue();
    try {
      await ctx.start();
      await vi.waitFor(() => expect(dialRecipient).toHaveBeenCalledOnce());
      const dial = dialRecipient.mock.calls[0]![0];
      await vi.waitFor(() => expect(dial.signal.aborted).toBe(true));
      expect(dial.recipientIdentity).toBe('transfer-recipient');
      expect(dial.room).toBeInstanceOf(Room);
      expect(dial.connection.url).toBe('wss://example.livekit.cloud');
      expect(ctx.sip).not.toHaveBeenCalled();
      const connect = ctx.task.toolCtx.functionTools.connect_to_caller!;
      await connect.execute({}, {} as never);
      expect(move).toHaveBeenCalledWith('consult-room', 'transfer-recipient', 'caller-room');
      expect(await ctx.outcome.await).toEqual({ humanAgentIdentity: 'transfer-recipient' });
      expect(ctx.session.currentAgent).toBe(ctx.parent);
    } finally {
      ctx.controller.abort();
      await ctx.session.close();
    }
  });

  it('resumes the caller without waiting for a pending dial after cancellation', async () => {
    const pending = new Future<void>();
    const dialRecipient = vi.fn<DialRecipient>().mockReturnValue(pending.await);
    const ctx = setup(dialRecipient);
    try {
      await ctx.start();
      await vi.waitFor(() => expect(dialRecipient).toHaveBeenCalledOnce());
      expect(ctx.task._agentActivity).toBeInstanceOf(AgentActivity);
      const reason = new Error('transfer cancelled');
      ctx.controller.abort(reason);
      expect(await ctx.outcome.await).toBe(reason);
      expect(ctx.session.currentAgent).toBe(ctx.parent);
      expect(dialRecipient.mock.calls[0]![0].signal.aborted).toBe(true);
      expect(pending.done).toBe(false);
      expect(ctx.disconnect).toHaveBeenCalledOnce();
    } finally {
      pending.resolve();
      ctx.controller.abort();
      await ctx.session.close();
    }
  });

  it.each(['throw', 'reject'] as const)(
    'resumes the caller when the dialer fails by %s',
    async (mode) => {
      const failure = new Error('provider unavailable');
      const dialRecipient: DialRecipient = () => {
        if (mode === 'throw') throw failure;
        return Promise.reject(failure);
      };
      const ctx = setup(dialRecipient);
      try {
        await ctx.start();
        expect(await ctx.outcome.await).toMatchObject({ message: 'could not dial human agent' });
        expect(ctx.session.currentAgent).toBe(ctx.parent);
        expect(ctx.disconnect).toHaveBeenCalledOnce();
      } finally {
        ctx.controller.abort();
        await ctx.session.close();
      }
    },
  );
});
