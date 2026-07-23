// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { OverlappingSpeechEvent } from '../inference/interruption/types.js';
import { type RealtimeCapabilities, RealtimeModel, type RealtimeSession } from '../llm/realtime.js';
import type { VADStream } from '../vad.js';
import { VAD as BaseVAD } from '../vad.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { AudioRecognition, type EndOfTurnInfo } from './audio_recognition.js';
import { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';

class FakeVAD extends BaseVAD {
  label = 'FakeVAD';

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): VADStream {
    throw new Error('not used in this test');
  }
}

class FakeRealtimeModel extends RealtimeModel {
  get model() {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    throw new Error('not used in this test');
  }

  async close() {}
}

function fakeCapabilities(overrides: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities {
  return {
    messageTruncation: false,
    turnDetection: false,
    userTranscription: false,
    autoToolReplyGeneration: false,
    audioOutput: true,
    manualFunctionCalls: false,
    midSessionChatCtxUpdate: false,
    midSessionInstructionsUpdate: false,
    midSessionToolsUpdate: false,
    ...overrides,
  };
}

function realtimeBargeInSession(): AgentSession {
  return new AgentSession({
    llm: new FakeRealtimeModel(fakeCapabilities({ turnDetection: false })),
    vad: new FakeVAD(),
    turnHandling: {
      turnDetection: 'vad',
      interruption: { mode: 'adaptive' },
    },
  });
}

function makeActivity(session: AgentSession): AgentActivity {
  return new AgentActivity(new Agent({ instructions: 'test' }), session);
}

function endOfTurnInfo(options: { backchannelOverAgent?: boolean } = {}): EndOfTurnInfo {
  return {
    newTranscript: '',
    transcriptConfidence: 0,
    transcriptionDelay: undefined,
    endOfUtteranceDelay: undefined,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
    backchannelOverAgent: options.backchannelOverAgent ?? false,
  };
}

type ActivityInternals = {
  isInterruptionDetectionEnabled: boolean;
  interruptionDetector?: unknown;
  _schedulingPaused: boolean;
  _currentSpeech?: SpeechHandle;
  interruptionDetected: boolean;
  realtimeSession?: { clearAudio: ReturnType<typeof vi.fn> };
  onEndOfTurn: (info: EndOfTurnInfo) => Promise<boolean>;
  onBackchannelConfirmed: () => void;
};

function setActivityProp<T>(activity: object, key: string, value: T): void {
  Object.defineProperty(activity, key, { configurable: true, value, writable: true });
}

describe('realtime adaptive interruption', () => {
  it('enables adaptive interruption for realtime without STT', () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'k');
    vi.stubEnv('LIVEKIT_API_SECRET', 's');

    const activity = makeActivity(realtimeBargeInSession()) as unknown as ActivityInternals;

    expect(activity.isInterruptionDetectionEnabled).toBe(true);
    expect(activity.interruptionDetector).toBeDefined();
  });

  it('still requires STT for non-realtime models', () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'k');
    vi.stubEnv('LIVEKIT_API_SECRET', 's');

    const session = new AgentSession({
      llm: new FakeLLM([]),
      vad: new FakeVAD(),
      turnHandling: {
        turnDetection: 'vad',
        interruption: { mode: 'adaptive' },
      },
    });
    const activity = makeActivity(session) as unknown as ActivityInternals;

    expect(activity.isInterruptionDetectionEnabled).toBe(false);
    expect(activity.interruptionDetector).toBeUndefined();
  });

  it('disables adaptive interruption for realtime with server turn detection', () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'k');
    vi.stubEnv('LIVEKIT_API_SECRET', 's');

    const session = new AgentSession({
      llm: new FakeRealtimeModel(fakeCapabilities({ turnDetection: true })),
      vad: new FakeVAD(),
      turnHandling: { interruption: { mode: 'adaptive' } },
    });
    const activity = makeActivity(session) as unknown as ActivityInternals;

    expect(activity.isInterruptionDetectionEnabled).toBe(false);
    expect(activity.interruptionDetector).toBeUndefined();
  });

  it('does not commit backchannels while agent speech is live', async () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'k');
    vi.stubEnv('LIVEKIT_API_SECRET', 's');

    const activity = makeActivity(realtimeBargeInSession()) as unknown as ActivityInternals;
    activity._schedulingPaused = false;
    activity._currentSpeech = SpeechHandle.create({ allowInterruptions: true });
    activity.interruptionDetected = false;

    expect(await activity.onEndOfTurn(endOfTurnInfo())).toBe(false);
  });

  it('drops confirmed backchannels after agent speech finishes', async () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'k');
    vi.stubEnv('LIVEKIT_API_SECRET', 's');

    const activity = makeActivity(realtimeBargeInSession()) as unknown as ActivityInternals;
    activity._schedulingPaused = false;
    activity._currentSpeech = undefined;
    activity.interruptionDetected = false;

    expect(await activity.onEndOfTurn(endOfTurnInfo({ backchannelOverAgent: true }))).toBe(false);
  });

  it('clears realtime audio on confirmed backchannel even when STT exists', () => {
    const activity = Object.create(AgentActivity.prototype) as ActivityInternals;
    const realtimeSession = { clearAudio: vi.fn() };
    Object.assign(activity, {
      isInterruptionDetectionEnabled: true,
      realtimeSession,
    });
    setActivityProp(activity, 'turnDetection', 'vad');

    activity.onBackchannelConfirmed();

    expect(realtimeSession.clearAudio).toHaveBeenCalledOnce();
  });

  it('does not clear realtime audio when barge-in is disabled', () => {
    const activity = Object.create(AgentActivity.prototype) as ActivityInternals;
    const realtimeSession = { clearAudio: vi.fn() };
    Object.assign(activity, {
      isInterruptionDetectionEnabled: false,
      realtimeSession,
    });
    setActivityProp(activity, 'turnDetection', 'vad');

    activity.onBackchannelConfirmed();

    expect(realtimeSession.clearAudio).not.toHaveBeenCalled();
  });
});

type RecognitionInternals = {
  backchannelBoundaryTimer?: ReturnType<typeof setTimeout>;
  overlapInCurrentTurn: boolean;
  turnBackchannelOverAgent: boolean;
  speaking: boolean;
  hooks: {
    onInterruption: ReturnType<typeof vi.fn>;
    onBackchannelConfirmed: ReturnType<typeof vi.fn>;
  };
  onOverlapSpeechEvent: (ev: OverlappingSpeechEvent) => void;
};

function recognitionForOverlap(options: { speaking?: boolean } = {}): RecognitionInternals {
  const recognition = Object.create(AudioRecognition.prototype) as RecognitionInternals;
  Object.assign(recognition, {
    backchannelBoundaryTimer: undefined,
    overlapInCurrentTurn: true,
    turnBackchannelOverAgent: false,
    speaking: options.speaking ?? false,
    hooks: {
      onInterruption: vi.fn(),
      onBackchannelConfirmed: vi.fn(),
    },
  });
  return recognition;
}

function overlapEvent(options: {
  isInterruption: boolean;
  agentEnded: boolean;
}): OverlappingSpeechEvent {
  return {
    type: 'overlapping_speech',
    detectedAt: Date.now(),
    isInterruption: options.isInterruption,
    agentEnded: options.agentEnded,
    totalDurationInS: 0,
    predictionDurationInS: 0,
    detectionDelayInS: 0,
    probability: options.isInterruption ? 1 : 0,
    numRequests: 0,
  };
}

describe('AudioRecognition realtime adaptive backchannel verdicts', () => {
  it('latches user-ended overlap as a backchannel', () => {
    const recognition = recognitionForOverlap();
    recognition.onOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: false }));
    expect(recognition.turnBackchannelOverAgent).toBe(true);
  });

  it('clears audio for confirmed backchannel between segments', () => {
    const recognition = recognitionForOverlap({ speaking: false });
    recognition.onOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: false }));
    expect(recognition.hooks.onBackchannelConfirmed).toHaveBeenCalledOnce();
  });

  it('defers audio clear for confirmed backchannel while user is speaking', () => {
    const recognition = recognitionForOverlap({ speaking: true });
    recognition.onOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: false }));
    expect(recognition.turnBackchannelOverAgent).toBe(true);
    expect(recognition.hooks.onBackchannelConfirmed).not.toHaveBeenCalled();
  });

  it('does not treat agent-ended overlap as a backchannel', () => {
    const recognition = recognitionForOverlap();
    recognition.onOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: true }));
    expect(recognition.turnBackchannelOverAgent).toBe(false);
    expect(recognition.hooks.onBackchannelConfirmed).not.toHaveBeenCalled();
  });

  it('preserves a prior backchannel when a later agent-ended overlap arrives', () => {
    const recognition = recognitionForOverlap();
    recognition.turnBackchannelOverAgent = true;
    recognition.onOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: true }));
    expect(recognition.turnBackchannelOverAgent).toBe(true);
  });

  it('clears backchannel verdict on interruption', () => {
    const recognition = recognitionForOverlap();
    recognition.turnBackchannelOverAgent = true;
    recognition.onOverlapSpeechEvent(overlapEvent({ isInterruption: true, agentEnded: false }));
    expect(recognition.turnBackchannelOverAgent).toBe(false);
    expect(recognition.hooks.onInterruption).toHaveBeenCalledOnce();
    expect(recognition.hooks.onBackchannelConfirmed).not.toHaveBeenCalled();
  });
});
