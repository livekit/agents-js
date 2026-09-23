// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind, type RemoteParticipant } from '@livekit/rtc-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FunctionCall } from '../llm/chat_context.js';
import { tool } from '../llm/tool_context.js';
import type { STTError } from '../stt/stt.js';
import { Future } from '../utils.js';
import { AgentSession, resolveRecordingOptions } from './agent_session.js';
import { AgentSessionEventTypes, CloseReason, createUserInputTranscribedEvent } from './events.js';
import { RunContext } from './run_context.js';
import { SpeechHandle } from './speech_handle.js';
import { ToolExecutor } from './tool_executor.js';

type AgentSessionInternals = AgentSession & {
  started: boolean;
  closing: boolean;
  _agentState: string;
  _aecWarmupTimer: NodeJS.Timeout | null;
  _userState: string;
  userAwayTimer: NodeJS.Timeout | null;
  _setUserAwayTimer: () => void;
};

type AgentSessionCloseInternals = {
  started: boolean;
  closingTask: Promise<void> | null;
  sessionHost?: { close: () => Promise<void> };
};

describe('AgentSession close', () => {
  it('waits for an internal close already in progress', async () => {
    const session = new AgentSession({ vad: null });
    const internals = session as unknown as AgentSessionCloseInternals;
    const closeStarted = new Future<void>();
    const finishClose = new Future<void>();
    const closeSessionHost = vi.fn(async () => {
      closeStarted.resolve();
      await finishClose.await;
    });
    internals.started = true;
    internals.sessionHost = { close: closeSessionHost };

    session._closeSoon({ reason: CloseReason.PARTICIPANT_DISCONNECTED });
    await closeStarted.await;

    const firstClose = internals.closingTask!;
    let secondCloseSettled = false;
    const secondClose = session.close().finally(() => {
      secondCloseSettled = true;
    });

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondCloseSettled).toBe(false);
    } finally {
      finishClose.resolve();
      await Promise.allSettled([firstClose, secondClose]);
    }

    expect(closeSessionHost).toHaveBeenCalledOnce();
  });
});

describe('AgentSession AEC warmup', () => {
  it.each([
    [ParticipantKind.SIP, {}, null],
    [ParticipantKind.SIP, { 'sip.ruleID': 'SDR_inbound' }, 3000],
    [ParticipantKind.STANDARD, {}, 3000],
  ] as const)(
    'uses the call type default for participant kind %s with attributes %o',
    (kind, attributes, expectedDuration) => {
      const session = new AgentSession({ vad: null });
      const participant = { info: { kind }, attributes } as RemoteParticipant;

      session._onRoomIOParticipantLinked(participant);

      expect(session.sessionOptions.aecWarmupDuration).toBe(expectedDuration);
      expect(session._aecWarmupRemaining).toBe(expectedDuration ?? 0);
    },
  );

  it.each([null, 0, 1500] as const)(
    'preserves an explicit AEC warmup duration of %s for outbound SIP',
    (duration) => {
      const session = new AgentSession({ vad: null, aecWarmupDuration: duration });
      const participant = {
        info: { kind: ParticipantKind.SIP },
        attributes: {},
      } as RemoteParticipant;

      session._onRoomIOParticipantLinked(participant);

      expect(session.sessionOptions.aecWarmupDuration).toBe(duration);
      expect(session._aecWarmupRemaining).toBe(duration ?? 0);
    },
  );

  it('cancels AEC warmup that already started for outbound SIP', () => {
    const session = new AgentSession({ vad: null });
    const internals = session as AgentSessionInternals;
    const timer = setTimeout(() => {}, 10_000);
    internals._aecWarmupTimer = timer;
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const participant = {
      info: { kind: ParticipantKind.SIP },
      attributes: {},
    } as RemoteParticipant;

    session._onRoomIOParticipantLinked(participant);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    expect(internals._aecWarmupTimer).toBeNull();
    clearTimeoutSpy.mockRestore();
  });
});

describe('AgentSession.run', () => {
  it('forwards inputModality to generateReply', async () => {
    const session = new AgentSession();
    const generateReply = vi
      .spyOn(session, 'generateReply')
      .mockImplementation(() => SpeechHandle.create());

    session.run({ userInput: 'hello', inputModality: 'audio' });

    await vi.waitFor(() => {
      expect(generateReply).toHaveBeenCalledWith({
        userInput: 'hello',
        inputModality: 'audio',
      });
    });
  });
});

describe('resolveRecordingOptions', () => {
  it('treats a boolean as all-on or all-off', () => {
    expect(resolveRecordingOptions(true)).toEqual({
      audio: true,
      traces: true,
      logs: true,
      transcript: true,
      redaction: false,
    });
    expect(resolveRecordingOptions(false)).toEqual({
      audio: false,
      traces: false,
      logs: false,
      transcript: false,
      redaction: false,
    });
  });

  it('defaults omitted keys to true when given a partial object', () => {
    expect(resolveRecordingOptions({ audio: false })).toEqual({
      audio: false,
      traces: true,
      logs: true,
      transcript: true,
      redaction: false,
    });

    expect(resolveRecordingOptions({ redaction: true })).toEqual({
      audio: true,
      traces: true,
      logs: true,
      transcript: true,
      redaction: true,
    });

    // The granular form from the docs: keep audio, drop everything else.
    expect(
      resolveRecordingOptions({
        audio: true,
        traces: false,
        logs: false,
        transcript: false,
        redaction: true,
      }),
    ).toEqual({
      audio: true,
      traces: false,
      logs: false,
      transcript: false,
      redaction: true,
    });
  });

  it('returns a fresh object so callers cannot corrupt the shared defaults', () => {
    const opts = resolveRecordingOptions(true);
    opts.audio = false;
    expect(resolveRecordingOptions(true).audio).toBe(true);
  });
});

describe('AgentSession recording state', () => {
  it('_enableRecording is true when any category is on and false when all are off', () => {
    const session = new AgentSession();
    // Defaults to all-off until start() resolves the record argument.
    expect(session._enableRecording).toBe(false);

    session.sessionOptions.recordingOptions = resolveRecordingOptions({
      audio: false,
      traces: false,
      logs: true,
      transcript: false,
      redaction: false,
    });
    expect(session._enableRecording).toBe(true);

    session.sessionOptions.recordingOptions = resolveRecordingOptions({
      audio: false,
      traces: false,
      logs: false,
      transcript: false,
      redaction: true,
    });
    expect(session._enableRecording).toBe(false);

    session.sessionOptions.recordingOptions = resolveRecordingOptions(false);
    expect(session._enableRecording).toBe(false);
  });
});

describe('AgentSession user input transcription', () => {
  it('resets the away timer on final transcripts when not speaking', () => {
    const session = new AgentSession({ userAwayTimeout: 15 });
    const internals = session as AgentSessionInternals;

    internals._agentState = 'listening';
    internals._userState = 'listening';

    const finalTranscript = createUserInputTranscribedEvent({
      transcript: 'hello',
      isFinal: true,
    });
    const interimTranscript = createUserInputTranscribedEvent({
      transcript: 'hello',
      isFinal: false,
    });

    const setTimer = vi.spyOn(internals, '_setUserAwayTimer').mockImplementation(() => {});
    session.emit(AgentSessionEventTypes.UserInputTranscribed, finalTranscript);
    expect(setTimer).toHaveBeenCalledOnce();
    expect(session.userState).toBe('listening');
    setTimer.mockRestore();

    const setTimerForInterim = vi
      .spyOn(internals, '_setUserAwayTimer')
      .mockImplementation(() => {});
    session.emit(AgentSessionEventTypes.UserInputTranscribed, interimTranscript);
    expect(setTimerForInterim).not.toHaveBeenCalled();
    setTimerForInterim.mockRestore();

    internals._userState = 'speaking';
    const setTimerWhileSpeaking = vi
      .spyOn(internals, '_setUserAwayTimer')
      .mockImplementation(() => {});
    session.emit(AgentSessionEventTypes.UserInputTranscribed, finalTranscript);
    expect(setTimerWhileSpeaking).not.toHaveBeenCalled();
    setTimerWhileSpeaking.mockRestore();
  });
});

describe('AgentSession resetAwayTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function startedSession(timeout: number | null = 3): AgentSessionInternals {
    const session = new AgentSession({ vad: null, userAwayTimeout: timeout });
    const internals = session as AgentSessionInternals;
    internals.started = true;
    internals._agentState = 'listening';
    internals._userState = 'listening';
    internals._setUserAwayTimer();
    return internals;
  }

  it('restarts the full timeout', async () => {
    const session = startedSession();
    const userStates: string[] = [];
    session.on(AgentSessionEventTypes.UserStateChanged, (event) => userStates.push(event.newState));

    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      session.resetAwayTimer();
    }

    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.userState).toBe('listening');
    expect(userStates).toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.userState).toBe('away');
    expect(userStates).toEqual(['away']);
  });

  it.each(['listening', 'speaking', 'thinking'] as const)(
    'returns an away user to listening while the agent is %s',
    async (agentState) => {
      const session = startedSession();
      const transitions: [string, string][] = [];
      session.on(AgentSessionEventTypes.UserStateChanged, (event) =>
        transitions.push([event.oldState, event.newState]),
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(session.userState).toBe('away');

      session._updateAgentState(agentState);
      session.resetAwayTimer();
      expect(session.userState).toBe('listening');
      expect(transitions).toEqual([
        ['listening', 'away'],
        ['away', 'listening'],
      ]);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(session.userState).toBe(agentState === 'listening' ? 'away' : 'listening');
    },
  );

  it.each([
    ['speaking', 'listening'],
    ['listening', 'speaking'],
    ['listening', 'thinking'],
  ] as const)('preserves active turns for user=%s agent=%s', async (userState, agentState) => {
    const session = startedSession();
    session._updateUserState(userState);
    session._updateAgentState(agentState);

    session.resetAwayTimer();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(session.userState).toBe(userState);
    expect(session.agentState).toBe(agentState);

    session._updateUserState('listening');
    session._updateAgentState('listening');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(session.userState).toBe('away');
  });

  it('is a no-op when away detection is disabled', async () => {
    const session = startedSession(null);
    session.resetAwayTimer();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.userState).toBe('listening');
    expect(session.userAwayTimer).toBeNull();
  });

  it('is a no-op outside the session lifetime', () => {
    const session = new AgentSession({ vad: null, userAwayTimeout: 3 }) as AgentSessionInternals;
    session._agentState = 'listening';
    session.resetAwayTimer();
    expect(session.userAwayTimer).toBeNull();

    session.started = true;
    session._setUserAwayTimer();
    const timer = session.userAwayTimer;
    session.closing = true;
    session.resetAwayTimer();
    expect(session.userAwayTimer).toBe(timer);
  });

  it('does not restart the timeout while a tool is running', async () => {
    const session = startedSession();
    const executor = new ToolExecutor();
    const releaseTool = new Future<void>();
    const lookup = tool({
      name: 'lookup',
      description: 'Lookup',
      execute: async () => {
        await releaseTool.await;
        return 'done';
      },
    });
    const runCtx = new RunContext(
      session,
      SpeechHandle.create(),
      FunctionCall.create({ callId: 'call_lookup', name: 'lookup', args: '{}' }),
    );
    const toolResult = executor.execute({ tool: lookup, runCtx, rawArguments: {} });
    await vi.waitFor(() => expect(executor.hasRunningTasks).toBe(true));

    session._updateAgentState('thinking');
    session._updateAgentState('listening');
    session.resetAwayTimer();
    expect(session.userAwayTimer).toBeNull();

    releaseTool.resolve();
    await toolResult;
  });
});

describe('AgentSession STT error tolerance', () => {
  function sttError(): STTError {
    return {
      type: 'stt_error',
      timestamp: Date.now(),
      label: 'test',
      error: new Error('stt unavailable'),
      recoverable: false,
    };
  }

  type Internals = AgentSessionCloseInternals & { sttErrorCounts: number };

  it('tolerates unrecoverable STT errors up to maxUnrecoverableErrors, like LLM and TTS', async () => {
    const session = new AgentSession({ vad: null, connOptions: { maxUnrecoverableErrors: 1 } });
    const internals = session as unknown as Internals;

    session._onError(sttError());
    expect(internals.closingTask).toBeNull();
    expect(internals.sttErrorCounts).toBe(1);

    session._onError(sttError());
    expect(internals.closingTask).not.toBeNull();
    await internals.closingTask;
  });

  it('resets the STT error count on a real user transcript', async () => {
    const session = new AgentSession({ vad: null, connOptions: { maxUnrecoverableErrors: 1 } });
    const internals = session as unknown as Internals;

    session._onError(sttError());
    expect(internals.sttErrorCounts).toBe(1);

    session.emit(
      AgentSessionEventTypes.UserInputTranscribed,
      createUserInputTranscribedEvent({ transcript: 'hello', isFinal: true }),
    );
    expect(internals.sttErrorCounts).toBe(0);

    // an empty placeholder transcript is not a recovery
    session._onError(sttError());
    session.emit(
      AgentSessionEventTypes.UserInputTranscribed,
      createUserInputTranscribedEvent({ transcript: '', isFinal: false }),
    );
    expect(internals.sttErrorCounts).toBe(1);

    session._onError(sttError());
    expect(internals.closingTask).not.toBeNull();
    await internals.closingTask;
  });
});
