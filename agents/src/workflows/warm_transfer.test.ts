// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { SIPParticipantInfo } from '@livekit/protocol';
import { DisconnectReason, ParticipantKind, Room, RoomEvent } from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient, SipClient, TokenVerifier } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceExecutor } from '../ipc/inference_executor.js';
import * as job from '../job.js';
import { JobContext, type JobProcess, type RunningJobInfo } from '../job.js';
import { JobTokenClient } from '../job_token.js';
import { ChatContext, type FunctionTool } from '../llm/index.js';
import { log } from '../log.js';
import { AgentTask } from '../voice/agent.js';
import { AgentSession } from '../voice/agent_session.js';
import { BackgroundAudioPlayer } from '../voice/background_audio.js';
import { SpeechHandle } from '../voice/speech_handle.js';
import {
  type WarmTransferResult,
  createCallerHangupSpeech,
  createWarmTransferSpeech,
  createWarmTransferTask,
  resolveHumanAgentRoomName,
} from './warm_transfer.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const createFakeTask = () => {
  let done = false;
  const complete = vi.fn(() => {
    done = true;
  });
  const setInputAudioEnabled = vi.fn();
  const setOutputAudioEnabled = vi.fn();
  const setOutputTranscriptionEnabled = vi.fn();
  const task = {
    get done() {
      return done;
    },
    complete,
    instructions: '',
    stt: undefined,
    vad: undefined,
    llm: undefined,
    tts: undefined,
    toolCtx: { tools: [] },
    chatCtx: ChatContext.empty(),
    session: {
      stt: undefined,
      vad: undefined,
      llm: undefined,
      tts: undefined,
      turnDetection: undefined,
      input: {
        audio: {},
        audioEnabled: true,
        setAudioEnabled: setInputAudioEnabled,
      },
      output: {
        audio: {},
        audioEnabled: true,
        transcription: {},
        transcriptionEnabled: true,
        setAudioEnabled: setOutputAudioEnabled,
        setTranscriptionEnabled: setOutputTranscriptionEnabled,
      },
    },
  } as unknown as AgentTask<WarmTransferResult>;
  const create = vi.spyOn(AgentTask, 'create').mockReturnValue(task);
  return {
    complete,
    create,
    setInputAudioEnabled,
    setOutputAudioEnabled,
    setOutputTranscriptionEnabled,
  };
};

const createCallerRoom = (): Room =>
  ({
    name: 'caller-room',
    localParticipant: { identity: 'transfer-agent' },
    remoteParticipants: new Map([
      ['caller', { identity: 'caller', kind: ParticipantKind.STANDARD }],
    ]),
    on: vi.fn(),
    off: vi.fn(),
  }) as unknown as Room;

const mockDial = (sipParticipant: Promise<unknown> = Promise.resolve({})) => {
  vi.stubEnv('LIVEKIT_API_KEY', 'api-key');
  vi.stubEnv('LIVEKIT_API_SECRET', 'api-secret');
  vi.spyOn(AccessToken.prototype, 'toJwt').mockResolvedValue('token');
  const connect = vi.spyOn(Room.prototype, 'connect').mockImplementation(async function () {
    Object.defineProperty(this, 'name', {
      configurable: true,
      value: 'caller-room-human-agent',
    });
    Object.defineProperty(this, 'isConnected', {
      configurable: true,
      get: () => true,
    });
  });
  const disconnect = vi.spyOn(Room.prototype, 'disconnect').mockResolvedValue();
  vi.spyOn(AgentSession.prototype, 'start').mockResolvedValue();
  const close = vi.spyOn(AgentSession.prototype, 'close').mockResolvedValue();
  const shutdown = vi.spyOn(AgentSession.prototype, 'shutdown').mockImplementation(() => {});
  const createSipParticipant = vi
    .spyOn(SipClient.prototype, 'createSipParticipant')
    .mockReturnValue(sipParticipant as never);
  vi.spyOn(BackgroundAudioPlayer.prototype, 'close').mockResolvedValue();
  return { close, connect, createSipParticipant, disconnect, shutdown };
};

const setupTransfer = (abortSignal: AbortSignal) => {
  const callerRoom = createCallerRoom();
  vi.spyOn(job, 'getJobContext').mockReturnValue({
    room: callerRoom,
    info: {
      url: 'ws://localhost:7880',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
    },
    createParticipantToken: async () => 'token',
  } as unknown as JobContext);
  const fakeTask = createFakeTask();
  createWarmTransferTask({
    abortSignal,
    sipCallTo: '+15551234567',
    sipTrunkId: 'ST_dummy',
    holdAudio: null,
  });
  return { callerRoom, ...fakeTask };
};

describe('resolveHumanAgentRoomName', () => {
  it('defaults to `<callerRoom>-human-agent` when no override is given', () => {
    expect(resolveHumanAgentRoomName('call-123')).toBe('call-123-human-agent');
  });

  it('returns the override when provided', () => {
    expect(resolveHumanAgentRoomName('call-123', 'consult-abc')).toBe('consult-abc');
  });

  it('rejects an override equal to the caller room name', () => {
    expect(() => resolveHumanAgentRoomName('call-123', 'call-123')).toThrow(
      /must differ from the caller room name/,
    );
  });
});

describe('createWarmTransferTask', () => {
  it('rejects an empty roomName', () => {
    expect(() =>
      createWarmTransferTask({
        sipCallTo: '+15551234567',
        sipTrunkId: 'ST_dummy',
        roomName: '',
      }),
    ).toThrow(/must not be empty/);
  });

  it('aborts before dialing when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('application shutdown');
    controller.abort(reason);
    const { close, createSipParticipant, disconnect } = mockDial();
    const { complete, create } = setupTransfer(controller.signal);

    await create.mock.calls[0]![0].onEnter!({} as never);

    expect(complete).toHaveBeenCalledWith(reason);
    expect(createSipParticipant).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('aborts a pending dial with the signal reason', async () => {
    const controller = new AbortController();
    const reason = new Error('application shutdown');
    const dial = new Promise<never>(() => {});
    const { close, createSipParticipant, disconnect, shutdown } = mockDial(dial);
    const { complete, create } = setupTransfer(controller.signal);

    const entering = create.mock.calls[0]![0].onEnter!({} as never);
    await vi.waitFor(() => expect(createSipParticipant).toHaveBeenCalled());
    controller.abort(reason);
    await entering;

    expect(complete).toHaveBeenCalledWith(reason);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith({ drain: false });
    expect(close).not.toHaveBeenCalled();
  });

  it('does not block cancellation on transfer session teardown', async () => {
    const controller = new AbortController();
    const reason = new Error('application shutdown');
    const dial = new Promise<never>(() => {});
    const { close, createSipParticipant, disconnect, shutdown } = mockDial(dial);
    close.mockReturnValue(new Promise<void>(() => {}));
    const { complete, create } = setupTransfer(controller.signal);

    const entering = create.mock.calls[0]![0].onEnter!({} as never);
    await vi.waitFor(() => expect(createSipParticipant).toHaveBeenCalled());
    controller.abort(reason);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(reason));

    const outcome = await Promise.race([
      entering.then(() => 'completed' as const),
      new Promise<'timed out'>((resolve) => {
        setTimeout(() => resolve('timed out'), 100);
      }),
    ]);

    expect(outcome).toBe('completed');
    expect(shutdown).toHaveBeenCalledWith({ drain: false });
    expect(close).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      disconnect.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps caller I/O disabled until cancellation cleanup exits the task', async () => {
    const controller = new AbortController();
    const reason = new Error('application shutdown');
    const dial = new Promise<never>(() => {});
    let finishDisconnect!: () => void;
    const disconnecting = new Promise<void>((resolve) => {
      finishDisconnect = resolve;
    });
    const { createSipParticipant, disconnect } = mockDial(dial);
    disconnect.mockReturnValue(disconnecting);
    const {
      complete,
      create,
      setInputAudioEnabled,
      setOutputAudioEnabled,
      setOutputTranscriptionEnabled,
    } = setupTransfer(controller.signal);
    const options = create.mock.calls[0]![0];

    const entering = options.onEnter!({} as never);
    await vi.waitFor(() => expect(createSipParticipant).toHaveBeenCalled());
    controller.abort(reason);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(reason));

    const ioStateBeforeExit = [
      setInputAudioEnabled.mock.lastCall?.[0],
      setOutputAudioEnabled.mock.lastCall?.[0],
      setOutputTranscriptionEnabled.mock.lastCall?.[0],
    ];
    finishDisconnect();
    await entering;
    await options.onExit!({} as never);

    expect(ioStateBeforeExit).toEqual([false, false, false]);
    expect(setInputAudioEnabled).toHaveBeenLastCalledWith(true);
    expect(setOutputAudioEnabled).toHaveBeenLastCalledWith(true);
    expect(setOutputTranscriptionEnabled).toHaveBeenLastCalledWith(true);
  });

  it('aborts an active consultation with the signal reason', async () => {
    const controller = new AbortController();
    const reason = new Error('consult deadline expired');
    const { shutdown } = mockDial();
    const { complete, create } = setupTransfer(controller.signal);

    await create.mock.calls[0]![0].onEnter!({} as never);
    controller.abort(reason);

    expect(complete).toHaveBeenCalledWith(reason);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('removes the abort listener when the framework exits the task', async () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    mockDial();
    const { create } = setupTransfer(controller.signal);

    const options = create.mock.calls[0]![0];
    await options.onEnter!({} as never);
    const listener = addEventListener.mock.calls.find(([event]) => event === 'abort')?.[1];
    expect(listener).toBeDefined();
    expect(options.onExit).toBeDefined();
    await options.onExit!({} as never);

    expect(removeEventListener).toHaveBeenCalledWith('abort', listener);
  });

  it.each(['completes', 'fails', 'times out'] as const)(
    'waits until caller-hangup notice playout %s before exiting and shutting down an answered agent',
    async (outcome) => {
      const controller = new AbortController();
      const playoutTimeoutController = new AbortController();
      const removalTimeoutController = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValueOnce(playoutTimeoutController.signal)
        .mockReturnValueOnce(removalTimeoutController.signal);
      let completePlayout!: () => void;
      let failPlayout!: (error: Error) => void;
      const playout = new Promise<void>((resolve, reject) => {
        completePlayout = resolve;
        failPlayout = reject;
      });
      const waitForPlayout = vi.fn().mockReturnValue(playout);
      vi.spyOn(AgentSession.prototype, 'interrupt').mockReturnValue({} as never);
      vi.spyOn(AgentSession.prototype, 'generateReply').mockReturnValue({
        waitForPlayout,
      } as never);
      let finishRemoval!: () => void;
      const removal = new Promise<void>((resolve) => {
        finishRemoval = resolve;
      });
      const removeParticipant = vi
        .spyOn(RoomServiceClient.prototype, 'removeParticipant')
        .mockReturnValue(removal as never);
      const { shutdown } = mockDial();
      const { callerRoom, create } = setupTransfer(controller.signal);

      const options = create.mock.calls[0]![0];
      await options.onEnter!({} as never);
      const onCallerLeft = vi
        .mocked(callerRoom.on)
        .mock.calls.find(([event]) => event === RoomEvent.ParticipantDisconnected)?.[1];
      expect(onCallerLeft).toBeDefined();
      (onCallerLeft as (participant: { identity: string; kind: ParticipantKind }) => void)({
        identity: 'caller',
        kind: ParticipantKind.STANDARD,
      });

      await vi.waitFor(() => expect(waitForPlayout).toHaveBeenCalledOnce());
      expect(shutdown).not.toHaveBeenCalled();
      let exitFinished = false;
      const exiting = Promise.resolve(options.onExit!({} as never)).then(() => {
        exitFinished = true;
      });
      await Promise.resolve();
      expect(exitFinished).toBe(false);

      if (outcome === 'completes') {
        completePlayout();
      } else if (outcome === 'fails') {
        failPlayout(new Error('playout failed'));
      } else {
        expect(timeout).toHaveBeenCalledWith(30_000);
        playoutTimeoutController.abort();
      }

      await vi.waitFor(
        () =>
          expect(removeParticipant).toHaveBeenCalledWith(
            'caller-room-human-agent',
            'human-agent-sip',
          ),
        { timeout: 200 },
      );
      expect(exitFinished).toBe(false);
      expect(shutdown).not.toHaveBeenCalled();
      finishRemoval();
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
      await exiting;
      expect(exitFinished).toBe(true);
    },
  );

  it('stops waiting when removing the human agent after caller hangup times out', async () => {
    const controller = new AbortController();
    const playoutTimeoutController = new AbortController();
    const removalTimeoutController = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(playoutTimeoutController.signal)
      .mockReturnValueOnce(removalTimeoutController.signal);
    vi.spyOn(AgentSession.prototype, 'interrupt').mockReturnValue({} as never);
    vi.spyOn(AgentSession.prototype, 'generateReply').mockReturnValue({
      waitForPlayout: vi.fn().mockResolvedValue(undefined),
    } as never);
    const removeParticipant = vi
      .spyOn(RoomServiceClient.prototype, 'removeParticipant')
      .mockReturnValue(new Promise<never>(() => {}) as never);
    const { shutdown } = mockDial();
    const {
      callerRoom,
      create,
      setInputAudioEnabled,
      setOutputAudioEnabled,
      setOutputTranscriptionEnabled,
    } = setupTransfer(controller.signal);

    const options = create.mock.calls[0]![0];
    await options.onEnter!({} as never);
    const onCallerLeft = vi
      .mocked(callerRoom.on)
      .mock.calls.find(([event]) => event === RoomEvent.ParticipantDisconnected)?.[1];
    expect(onCallerLeft).toBeDefined();
    (onCallerLeft as (participant: { identity: string; kind: ParticipantKind }) => void)({
      identity: 'caller',
      kind: ParticipantKind.STANDARD,
    });

    let exitFinished = false;
    const exiting = Promise.resolve(options.onExit!({} as never)).then(() => {
      exitFinished = true;
    });
    await vi.waitFor(() => expect(removeParticipant).toHaveBeenCalledOnce());
    expect(timeout).toHaveBeenNthCalledWith(1, 30_000);
    await vi.waitFor(() => expect(timeout).toHaveBeenNthCalledWith(2, 10_000), { timeout: 200 });
    expect(exitFinished).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();

    removalTimeoutController.abort();
    await exiting;

    expect(shutdown).toHaveBeenCalledOnce();
    expect(setInputAudioEnabled).toHaveBeenLastCalledWith(true);
    expect(setOutputAudioEnabled).toHaveBeenLastCalledWith(true);
    expect(setOutputTranscriptionEnabled).toHaveBeenLastCalledWith(true);
  });

  it('lets a successful participant move win over an abort', async () => {
    const controller = new AbortController();
    mockDial();
    let finishMove!: () => void;
    const move = new Promise<void>((resolve) => {
      finishMove = resolve;
    });
    const moveParticipant = vi
      .spyOn(RoomServiceClient.prototype, 'moveParticipant')
      .mockReturnValue(move as never);
    const { complete, create } = setupTransfer(controller.signal);

    const options = create.mock.calls[0]![0];
    await options.onEnter!({} as never);
    const connect = (options.tools as FunctionTool[]).find(
      (entry) => entry.name === 'connect_to_caller',
    )!;
    const merging = connect.execute({}, {} as never);
    await vi.waitFor(() => expect(moveParticipant).toHaveBeenCalled());

    controller.abort(new Error('application shutdown'));
    expect(complete).not.toHaveBeenCalled();
    finishMove();
    await merging;

    expect(complete).toHaveBeenCalledWith({ humanAgentIdentity: 'human-agent-sip' });
  });

  it('uses the abort reason when the concurrent participant move fails', async () => {
    const controller = new AbortController();
    const reason = new Error('application shutdown');
    mockDial();
    let failMove!: (error: Error) => void;
    const move = new Promise<void>((_resolve, reject) => {
      failMove = reject;
    });
    const moveParticipant = vi
      .spyOn(RoomServiceClient.prototype, 'moveParticipant')
      .mockReturnValue(move as never);
    const { complete, create } = setupTransfer(controller.signal);

    const options = create.mock.calls[0]![0];
    await options.onEnter!({} as never);
    const connect = (options.tools as FunctionTool[]).find(
      (entry) => entry.name === 'connect_to_caller',
    )!;
    const merging = connect.execute({}, {} as never);
    await vi.waitFor(() => expect(moveParticipant).toHaveBeenCalled());

    controller.abort(reason);
    failMove(new Error('move failed'));
    await merging;

    expect(complete).toHaveBeenCalledWith(reason);
  });

  it('observes aborts after a participant move fails', async () => {
    const controller = new AbortController();
    const reason = new Error('application shutdown');
    mockDial();
    vi.spyOn(RoomServiceClient.prototype, 'moveParticipant').mockRejectedValue(
      new Error('move failed'),
    );
    const { complete, create } = setupTransfer(controller.signal);

    const options = create.mock.calls[0]![0];
    await options.onEnter!({} as never);
    const connect = (options.tools as FunctionTool[]).find(
      (entry) => entry.name === 'connect_to_caller',
    )!;

    await expect(connect.execute({}, {} as never)).rejects.toThrow('move failed');
    controller.abort(reason);

    expect(complete).toHaveBeenCalledWith(reason);
  });

  it.each(['before', 'after'] as const)(
    'observes human agent room closure %s a participant move failure',
    async (timing) => {
      const controller = new AbortController();
      const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
      const { connect: connectRoom } = mockDial();
      let failMove!: (error: Error) => void;
      const move = new Promise<void>((_resolve, reject) => {
        failMove = reject;
      });
      const moveParticipant = vi
        .spyOn(RoomServiceClient.prototype, 'moveParticipant')
        .mockReturnValue(move as never);
      const { complete, create } = setupTransfer(controller.signal);

      const options = create.mock.calls[0]![0];
      await options.onEnter!({} as never);
      const connect = (options.tools as FunctionTool[]).find(
        (entry) => entry.name === 'connect_to_caller',
      )!;
      const humanAgentRoom = connectRoom.mock.instances[0]!;
      const isConnected = vi.spyOn(humanAgentRoom, 'isConnected', 'get').mockReturnValue(true);

      const merging = connect.execute({}, {} as never);
      await vi.waitFor(() => expect(moveParticipant).toHaveBeenCalled());
      if (timing === 'before') {
        isConnected.mockReturnValue(false);
        humanAgentRoom.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
      }

      failMove(new Error('move failed'));
      await expect(merging).rejects.toThrow('move failed');
      if (timing === 'after') {
        expect(complete).not.toHaveBeenCalled();
        isConnected.mockReturnValue(false);
        humanAgentRoom.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
      }

      const expectedReason =
        timing === 'before' ? DisconnectReason.UNKNOWN_REASON : DisconnectReason.CLIENT_INITIATED;
      expect(warn).toHaveBeenCalledWith(
        { reason: expectedReason },
        'human agent room disconnected before transfer completed',
      );
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `Transfer failed: the human agent room disconnected before the transfer completed (reason: ${expectedReason}). The caller has not been connected to a human agent.`,
        }),
      );
    },
  );

  it('starts greeting speech only after the outbound SIP call answers', async () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'api-key');
    vi.stubEnv('LIVEKIT_API_SECRET', 'api-secret');
    let resolveAnswer!: (participant: SIPParticipantInfo) => void;
    const answer = new Promise<SIPParticipantInfo>((resolve) => {
      resolveAnswer = resolve;
    });
    const createSipParticipant = vi
      .spyOn(SipClient.prototype, 'createSipParticipant')
      .mockReturnValue(answer);
    vi.spyOn(AccessToken.prototype, 'toJwt').mockResolvedValue('token');
    vi.spyOn(Room.prototype, 'connect').mockResolvedValue();
    vi.spyOn(AgentSession.prototype, 'start').mockResolvedValue();

    const greetingSpeech = vi.fn(() => completedSpeechHandle());
    const callerRoom = {
      name: 'caller-room',
      localParticipant: { identity: 'transfer-agent' },
      remoteParticipants: new Map([
        ['caller', { identity: 'caller', kind: ParticipantKind.STANDARD }],
      ]),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Room;
    const callerSession = {
      input: { audioEnabled: true, audio: null },
      output: {
        audioEnabled: true,
        transcriptionEnabled: true,
        audio: null,
        transcription: null,
      },
      vad: undefined,
      llm: undefined,
      stt: undefined,
      tts: undefined,
      turnDetection: undefined,
    } as unknown as AgentSession;
    const task = createWarmTransferTask({
      sipCallTo: '+15551234567',
      sipTrunkId: 'ST_dummy',
      holdAudio: null,
      greetingSpeech,
    });
    task._agentActivity = { agentSession: callerSession } as never;
    const jobContext = {
      room: callerRoom,
      info: { url: 'wss://example.livekit.cloud' },
      createParticipantToken: async () => 'token',
    } as unknown as JobContext;

    const onEnter = job.runWithJobContextAsync(jobContext, () => task.onEnter());
    await vi.waitFor(() => expect(createSipParticipant).toHaveBeenCalledOnce());

    expect(greetingSpeech).not.toHaveBeenCalled();

    resolveAnswer(new SIPParticipantInfo());
    await onEnter;

    expect(greetingSpeech).toHaveBeenCalledOnce();
    expect(createSipParticipant).toHaveBeenCalledWith(
      'ST_dummy',
      '+15551234567',
      'caller-room-human-agent',
      expect.objectContaining({ waitUntilAnswered: true }),
      undefined,
    );
  });
});

describe('human agent room token', () => {
  const secret = 'secret'.repeat(6);
  const humanAgentRoomGrant = {
    roomJoin: true,
    room: 'caller-room-human-agent',
    canUpdateOwnMetadata: true,
    canPublish: true,
    canSubscribe: true,
  };

  function createJobContext(info: Partial<RunningJobInfo>) {
    return new JobContext(
      {} as unknown as JobProcess,
      {
        job: { id: 'job-id', room: { name: 'caller-room' } },
        url: 'ws://localhost:7880',
        ...info,
      } as unknown as RunningJobInfo,
      createCallerRoom(),
      vi.fn(),
      vi.fn(),
      {} as unknown as InferenceExecutor,
    );
  }

  /** Dials the human agent; returns the token the human agent room is joined with. */
  async function dialHumanAgent(ctx: JobContext): Promise<string> {
    const connect = vi.spyOn(Room.prototype, 'connect').mockResolvedValue();
    vi.spyOn(AgentSession.prototype, 'start').mockResolvedValue();
    const task = createWarmTransferTask({
      sipCallTo: '+15551234567',
      sipTrunkId: 'ST_dummy',
      holdAudio: null,
    });
    task._agentActivity = { agentSession: new AgentSession() } as never;
    const complete = vi.spyOn(task, 'complete').mockImplementation(() => {});

    await job.runWithJobContextAsync(ctx, () => task.onEnter());

    expect(complete).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]![0]).toBe('ws://localhost:7880');
    return connect.mock.calls[0]![1];
  }

  it('comes from CreateJobToken in token mode, as do the API calls', async () => {
    // there is no API key or secret to read
    vi.stubEnv('LIVEKIT_API_KEY', '');
    vi.stubEnv('LIVEKIT_API_SECRET', '');
    const toJwt = vi.spyOn(AccessToken.prototype, 'toJwt');
    const createJobToken = vi.fn(async () => ({ token: 'job-token', expiresAt: Date.now() + 1e6 }));
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const ctx = createJobContext({});
    ctx._jobTokens = new JobTokenClient(createJobToken);

    const token = await dialHumanAgent(ctx);

    expect(token).toBe('job-token');
    expect(createJobToken.mock.calls.map(([claims]) => JSON.parse(claims))).toEqual([
      { identity: 'transfer-agent', kind: 'agent', video: humanAgentRoomGrant },
      { video: {}, sip: { call: true } },
    ]);
    // the SIP participant is created with the job token
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/twirp/livekit.SIP/CreateSIPParticipant');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer job-token');
    expect(toJwt).not.toHaveBeenCalled();
  });

  it("is signed here with the worker's credentials in key mode", async () => {
    vi.spyOn(SipClient.prototype, 'createSipParticipant').mockResolvedValue(
      new SIPParticipantInfo(),
    );
    const ctx = createJobContext({ apiKey: 'devkey', apiSecret: secret });

    const token = await dialHumanAgent(ctx);

    const claims = await new TokenVerifier('devkey', secret).verify(token);
    expect(claims).toMatchObject({
      iss: 'devkey',
      sub: 'transfer-agent',
      kind: 'agent',
      video: humanAgentRoomGrant,
    });
    expect(claims.video).toEqual(humanAgentRoomGrant);
    expect(claims).not.toHaveProperty('name');
    expect(claims.exp! - claims.nbf!).toBe(6 * 3600); // the AccessToken default
  });

  it("signs the SIP call with the job's credentials in key mode", async () => {
    // the credentials come from CLI flags, not the environment
    vi.stubEnv('LIVEKIT_API_KEY', '');
    vi.stubEnv('LIVEKIT_API_SECRET', '');
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const ctx = createJobContext({ apiKey: 'devkey', apiSecret: secret });

    await dialHumanAgent(ctx);

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0]! as unknown as [URL, RequestInit];
    const auth = (init.headers as Record<string, string>).Authorization!;
    const claims = await new TokenVerifier('devkey', secret).verify(auth.slice('Bearer '.length));
    expect(claims.sip).toEqual({ call: true });
  });

  /**
   * Token mode: aborts the transfer while job token request `held` is pending, then lets the
   * token arrive. Request 1 is the human agent room token, request 2 is the SIP call token.
   */
  async function abortWhileJobTokenPending(held: number) {
    vi.stubEnv('LIVEKIT_API_KEY', '');
    vi.stubEnv('LIVEKIT_API_SECRET', '');
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let requests = 0;
    const createJobToken = vi.fn(async () => {
      if (++requests === held) await released;
      return { token: 'job-token', expiresAt: Date.now() + 1e6 };
    });
    const ctx = createJobContext({});
    ctx._jobTokens = new JobTokenClient(createJobToken);
    const connect = vi.spyOn(Room.prototype, 'connect').mockResolvedValue();
    vi.spyOn(Room.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(AgentSession.prototype, 'start').mockResolvedValue();
    vi.spyOn(AgentSession.prototype, 'shutdown').mockImplementation(() => {});
    const controller = new AbortController();
    const task = createWarmTransferTask({
      abortSignal: controller.signal,
      sipCallTo: '+15551234567',
      sipTrunkId: 'ST_dummy',
      holdAudio: null,
    });
    task._agentActivity = { agentSession: new AgentSession() } as never;
    vi.spyOn(task, 'complete').mockImplementation(() => {});

    const entering = job.runWithJobContextAsync(ctx, () => task.onEnter());
    await vi.waitFor(() => expect(createJobToken).toHaveBeenCalledTimes(held));
    controller.abort(new Error('caller hung up'));
    release();
    await entering;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { connect, fetch };
  }

  it('does not join the human agent room when the transfer ends while its token is pending', async () => {
    const { connect } = await abortWhileJobTokenPending(1);

    expect(connect).not.toHaveBeenCalled();
  });

  it('does not dial when the transfer ends while the SIP token is pending', async () => {
    const { connect, fetch } = await abortWhileJobTokenPending(2);

    expect(connect).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});

function completedSpeechHandle(): SpeechHandle {
  const handle = SpeechHandle.create();
  handle._markDone();
  return handle;
}

function createSession() {
  const sayHandle = completedSpeechHandle();
  const generatedHandle = completedSpeechHandle();
  const say = vi.fn(() => sayHandle);
  const generateReply = vi.fn(() => generatedHandle);
  const session = { say, generateReply } as unknown as AgentSession;

  return { session, say, sayHandle, generateReply, generatedHandle };
}

describe('createWarmTransferSpeech', () => {
  it('does nothing when no speech is configured', () => {
    const { session, say, generateReply } = createSession();

    expect(createWarmTransferSpeech(session, undefined)).toBeUndefined();
    expect(say).not.toHaveBeenCalled();
    expect(generateReply).not.toHaveBeenCalled();
  });

  it('speaks literal text with default say options', () => {
    const { session, say, sayHandle, generateReply } = createSession();

    expect(
      createWarmTransferSpeech(session, 'Hello, I am calling about a customer transfer.'),
    ).toBe(sayHandle);
    expect(say).toHaveBeenCalledWith('Hello, I am calling about a customer transfer.', undefined);
    expect(generateReply).not.toHaveBeenCalled();
  });

  it('uses a lazy factory to create any speech handle', () => {
    const { session, say, generateReply } = createSession();
    const customHandle = completedSpeechHandle();
    const factory = vi.fn(() => customHandle);

    expect(createWarmTransferSpeech(session, factory)).toBe(customHandle);
    expect(factory).toHaveBeenCalledWith(session);
    expect(say).not.toHaveBeenCalled();
    expect(generateReply).not.toHaveBeenCalled();
  });
});

describe('createCallerHangupSpeech', () => {
  it('speaks literal text without generating a reply', () => {
    const { session, say, sayHandle, generateReply } = createSession();

    expect(
      createCallerHangupSpeech(session, 'The caller disconnected. Hanging up now.', undefined),
    ).toBe(sayHandle);
    expect(say).toHaveBeenCalledWith('The caller disconnected. Hanging up now.', {
      allowInterruptions: false,
      addToChatCtx: false,
    });
    expect(generateReply).not.toHaveBeenCalled();
  });

  it('preserves the deprecated generated-reply path when no speech is configured', () => {
    const { session, say, generateReply, generatedHandle } = createSession();

    expect(
      createCallerHangupSpeech(session, undefined, 'Generate a short caller hangup message.'),
    ).toBe(generatedHandle);
    expect(generateReply).toHaveBeenCalledWith({
      instructions: 'Generate a short caller hangup message.',
      allowInterruptions: false,
      toolChoice: 'none',
    });
    expect(say).not.toHaveBeenCalled();
  });
});
