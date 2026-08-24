// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { SIPParticipantInfo } from '@livekit/protocol';
import { ParticipantKind, Room, RoomEvent } from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as job from '../job.js';
import type { JobContext } from '../job.js';
import { ChatContext, type FunctionTool } from '../llm/index.js';
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
  vi.spyOn(Room.prototype, 'connect').mockImplementation(async function () {
    Object.defineProperty(this, 'name', {
      configurable: true,
      value: 'caller-room-human-agent',
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
  return { close, createSipParticipant, disconnect, shutdown };
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
  } as JobContext);
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
    } as JobContext;

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
