// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as AudioModule from '../audio.js';
import { log } from '../log.js';
import type { AgentSession } from '../voice/agent_session.js';
import { BuiltinAudioClip } from '../voice/background_audio.js';
import { SpeechHandle } from '../voice/speech_handle.js';
import {
  createWarmTransferTask,
  notifyHumanAgentOfHangup,
  resolveHumanAgentRoomName,
  startCallerHangupSpeech,
} from './warm_transfer.js';

const { audioFramesFromFileMock } = vi.hoisted(() => ({
  audioFramesFromFileMock: vi.fn(),
}));

vi.mock('../audio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AudioModule>();
  return { ...actual, audioFramesFromFile: audioFramesFromFileMock };
});

afterEach(() => {
  vi.restoreAllMocks();
  audioFramesFromFileMock.mockReset();
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

  it('rejects both caller hangup options together', () => {
    expect(() =>
      createWarmTransferTask({
        sipCallTo: '+15551234567',
        sipTrunkId: 'ST_dummy',
        callerHangupNotice: { text: 'The caller disconnected. Hanging up now.' },
        callerHangupInstruction: 'Generate a short notice.',
      }),
    ).toThrow(/cannot both be set/);
  });

  it('rejects an empty deterministic notice', () => {
    expect(() =>
      createWarmTransferTask({
        sipCallTo: '+15551234567',
        sipTrunkId: 'ST_dummy',
        callerHangupNotice: { text: '   ' },
      }),
    ).toThrow(/callerHangupNotice\.text.*must not be empty/);
  });
});

type HangupSession = Pick<AgentSession, 'interrupt' | 'say' | 'generateReply' | 'shutdown'>;

function completedSpeechHandle(): SpeechHandle {
  const handle = SpeechHandle.create();
  handle._markDone();
  return handle;
}

function createSession() {
  const calls: string[] = [];
  const sayHandle = completedSpeechHandle();
  const generatedHandle = completedSpeechHandle();
  const interrupt = vi.fn(() => {
    calls.push('interrupt');
  });
  const say = vi.fn(() => {
    calls.push('say');
    return sayHandle;
  });
  const generateReply = vi.fn(() => {
    calls.push('generateReply');
    return generatedHandle;
  });
  const shutdown = vi.fn(() => {
    calls.push('shutdown');
  });
  const session = { interrupt, say, generateReply, shutdown } as unknown as HangupSession;

  return {
    calls,
    session,
    interrupt,
    say,
    sayHandle,
    generateReply,
    generatedHandle,
    shutdown,
  };
}

describe('startCallerHangupSpeech', () => {
  it('uses fixed text without generating a reply', () => {
    const { session, say, sayHandle, generateReply } = createSession();

    expect(
      startCallerHangupSpeech(
        session,
        { text: 'The caller disconnected. Hanging up now.' },
        'Generate a notice.',
        new AbortController().signal,
      ),
    ).toBe(sayHandle);
    expect(say).toHaveBeenCalledWith('The caller disconnected. Hanging up now.', {
      audio: undefined,
      allowInterruptions: false,
    });
    expect(generateReply).not.toHaveBeenCalled();
  });

  it('decodes a file path with the playout abort signal', () => {
    const { session, say, sayHandle, generateReply } = createSession();
    const audio = new ReadableStream<AudioFrame>();
    const abortSignal = new AbortController().signal;
    audioFramesFromFileMock.mockReturnValue(audio);

    expect(
      startCallerHangupSpeech(
        session,
        {
          text: 'The caller disconnected. Hanging up now.',
          audio: './caller-left.wav',
        },
        undefined,
        abortSignal,
      ),
    ).toBe(sayHandle);
    expect(audioFramesFromFileMock).toHaveBeenCalledWith('./caller-left.wav', { abortSignal });
    expect(say).toHaveBeenCalledWith('The caller disconnected. Hanging up now.', {
      audio,
      allowInterruptions: false,
    });
    expect(generateReply).not.toHaveBeenCalled();
  });

  it('resolves builtin audio clips to their file path', () => {
    const { session } = createSession();
    const audio = new ReadableStream<AudioFrame>();
    audioFramesFromFileMock.mockReturnValue(audio);

    startCallerHangupSpeech(
      session,
      {
        text: 'The caller disconnected. Hanging up now.',
        audio: BuiltinAudioClip.HOLD_MUSIC,
      },
      undefined,
      new AbortController().signal,
    );

    expect(audioFramesFromFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/resources[/\\]hold_music\.ogg$/),
      expect.any(Object),
    );
  });

  it('converts async iterable audio to a readable stream', async () => {
    const { session, say } = createSession();
    const frame = {} as AudioFrame;
    const audio = {
      async *[Symbol.asyncIterator]() {
        yield frame;
      },
    };

    startCallerHangupSpeech(
      session,
      { text: 'The caller disconnected. Hanging up now.', audio },
      undefined,
      new AbortController().signal,
    );

    const stream = say.mock.calls[0]?.[1]?.audio;
    expect(stream).toBeInstanceOf(ReadableStream);
    await expect(stream?.getReader().read()).resolves.toEqual({ value: frame, done: false });
  });

  it('cancels decoded audio and falls back when say throws', () => {
    const { session, say, generateReply, generatedHandle } = createSession();
    const error = new Error('AgentSession is closing, cannot use say()');
    const cancel = vi.fn();
    const audio = new ReadableStream<AudioFrame>({ cancel });
    audioFramesFromFileMock.mockReturnValue(audio);
    say.mockImplementation(() => {
      throw error;
    });
    const warn = vi.spyOn(log(), 'warn');

    expect(
      startCallerHangupSpeech(
        session,
        {
          text: 'The caller disconnected. Hanging up now.',
          audio: './caller-left.wav',
        },
        'Generate a short notice.',
        new AbortController().signal,
      ),
    ).toBe(generatedHandle);

    expect(cancel).toHaveBeenCalledWith(error);
    expect(generateReply).toHaveBeenCalledWith({
      instructions: 'Generate a short notice.',
      allowInterruptions: false,
      toolChoice: 'none',
    });
    expect(warn).toHaveBeenCalledWith(
      { error },
      'failed to play deterministic caller hangup notice, falling back to generated reply',
    );
  });

  it('preserves generated replies when no deterministic notice is configured', () => {
    const { session, say, generateReply, generatedHandle } = createSession();

    expect(
      startCallerHangupSpeech(
        session,
        undefined,
        'Generate a short notice.',
        new AbortController().signal,
      ),
    ).toBe(generatedHandle);
    expect(generateReply).toHaveBeenCalledWith({
      instructions: 'Generate a short notice.',
      allowInterruptions: false,
      toolChoice: 'none',
    });
    expect(say).not.toHaveBeenCalled();
  });

  it('uses the default instruction when no instruction is configured', () => {
    const { session, generateReply } = createSession();

    startCallerHangupSpeech(session, undefined, undefined, new AbortController().signal);

    expect(generateReply).toHaveBeenCalledWith({
      instructions:
        'The caller has hung up before the transfer could be completed.\nBriefly inform the human agent that the caller has left and that you are ending the call now.',
      allowInterruptions: false,
      toolChoice: 'none',
    });
  });
});

describe('notifyHumanAgentOfHangup', () => {
  it('interrupts before saying the notice and shuts down after playout', async () => {
    const { session, calls, interrupt, say, shutdown } = createSession();

    await notifyHumanAgentOfHangup(
      session,
      { text: 'The caller disconnected. Hanging up now.' },
      undefined,
    );

    expect(calls).toEqual(['interrupt', 'say', 'shutdown']);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(say).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('falls back to a generated reply when say throws', async () => {
    const { session, calls, say, generateReply, shutdown } = createSession();
    const error = new Error('trying to generate speech from text without a TTS model');
    say.mockImplementation(() => {
      calls.push('say');
      throw error;
    });
    const warn = vi.spyOn(log(), 'warn');

    await notifyHumanAgentOfHangup(
      session,
      { text: 'The caller disconnected. Hanging up now.' },
      undefined,
    );

    expect(calls).toEqual(['interrupt', 'say', 'generateReply', 'shutdown']);
    expect(generateReply).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { error },
      'failed to play deterministic caller hangup notice, falling back to generated reply',
    );
  });

  it('still shuts down when both notice paths throw', async () => {
    const { session, say, generateReply, shutdown } = createSession();
    say.mockImplementation(() => {
      throw new Error('say failed');
    });
    generateReply.mockImplementation(() => {
      throw new Error('generate failed');
    });

    await notifyHumanAgentOfHangup(
      session,
      { text: 'The caller disconnected. Hanging up now.' },
      undefined,
    );

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('bounds the playout wait before shutting down', async () => {
    const { session, say, shutdown } = createSession();
    say.mockReturnValue(SpeechHandle.create());

    await notifyHumanAgentOfHangup(
      session,
      { text: 'The caller disconnected. Hanging up now.' },
      undefined,
      1,
    );

    expect(shutdown).toHaveBeenCalledOnce();
  });
});
