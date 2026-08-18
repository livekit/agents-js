// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { SIPParticipantInfo } from '@livekit/protocol';
import { ParticipantKind, Room } from '@livekit/rtc-node';
import { AccessToken, SipClient } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContextAsync } from '../job.js';
import { AgentSession } from '../voice/agent_session.js';
import { SpeechHandle } from '../voice/speech_handle.js';
import {
  createCallerHangupSpeech,
  createWarmTransferSpeech,
  createWarmTransferTask,
  resolveHumanAgentRoomName,
} from './warm_transfer.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

    const onEnter = runWithJobContextAsync(jobContext, () => task.onEnter());
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
