// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
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

  it('uses a lazy factory to create any speech handle', () => {
    const { session, say, generateReply } = createSession();
    const customHandle = completedSpeechHandle();
    const factory = vi.fn(() => customHandle);

    expect(createCallerHangupSpeech(session, factory, undefined)).toBe(customHandle);
    expect(factory).toHaveBeenCalledWith(session);
    expect(say).not.toHaveBeenCalled();
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
