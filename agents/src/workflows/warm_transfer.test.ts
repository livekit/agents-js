// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../voice/agent_session.js';
import { SpeechHandle } from '../voice/speech_handle.js';
import {
  createCallerHangupSpeech,
  createWarmTransferTask,
  resolveHumanAgentRoomName,
} from './warm_transfer.js';

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
});

describe('createCallerHangupSpeech', () => {
  function createSession() {
    const sayHandle = SpeechHandle.create();
    const generatedHandle = SpeechHandle.create();
    const say = vi.fn(() => sayHandle);
    const generateReply = vi.fn(() => generatedHandle);
    const session = { say, generateReply } as unknown as Pick<
      AgentSession,
      'generateReply' | 'say'
    >;

    return { session, say, sayHandle, generateReply, generatedHandle };
  }

  it('uses fixed text without generating a reply', () => {
    const { session, say, sayHandle, generateReply } = createSession();

    expect(
      createCallerHangupSpeech(
        session,
        { text: 'The caller disconnected. Hanging up now.' },
        'Generate a notice.',
      ),
    ).toBe(sayHandle);
    expect(say).toHaveBeenCalledWith('The caller disconnected. Hanging up now.', {
      audio: undefined,
      allowInterruptions: false,
      addToChatCtx: false,
    });
    expect(generateReply).not.toHaveBeenCalled();
  });

  it('creates prerecorded audio only when starting the notice', () => {
    const { session, say, sayHandle, generateReply } = createSession();
    const audio = new ReadableStream<AudioFrame>();
    const createAudio = vi.fn(() => audio);

    expect(createAudio).not.toHaveBeenCalled();
    expect(
      createCallerHangupSpeech(
        session,
        {
          text: 'The caller disconnected. Hanging up now.',
          audio: createAudio,
        },
        undefined,
      ),
    ).toBe(sayHandle);
    expect(createAudio).toHaveBeenCalledOnce();
    expect(say).toHaveBeenCalledWith('The caller disconnected. Hanging up now.', {
      audio,
      allowInterruptions: false,
      addToChatCtx: false,
    });
    expect(generateReply).not.toHaveBeenCalled();
  });

  it('preserves generated replies when no deterministic notice is configured', () => {
    const { session, say, generateReply, generatedHandle } = createSession();

    expect(createCallerHangupSpeech(session, undefined, 'Generate a short notice.')).toBe(
      generatedHandle,
    );
    expect(generateReply).toHaveBeenCalledWith({
      instructions: 'Generate a short notice.',
      allowInterruptions: false,
      toolChoice: 'none',
    });
    expect(say).not.toHaveBeenCalled();
  });
});
