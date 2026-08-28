// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type {
  InterruptionSentinel,
  OverlappingSpeechEvent,
} from '../inference/interruption/types.js';
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
  pendingInterruption?: OverlappingSpeechEvent;
  realtimeSession?: { clearAudio: ReturnType<typeof vi.fn> };
  pausedSpeech?: { handle: SpeechHandle; agentState: 'speaking'; timeout: number };
  createSpeechTask: ReturnType<typeof vi.fn>;
  onEndOfTurn: (info: EndOfTurnInfo) => Promise<boolean>;
  onBackchannelConfirmed: () => void;
};

type InterruptionActivityHarness = {
  isInterruptionByAudioActivityEnabled: boolean;
  agent: { _llm: object; _stt?: object };
  agentSession: {
    _textOnly: boolean;
    _aecWarmupRemaining: number;
    sessionOptions: { turnHandling: { interruption: { minWords: number } } };
  };
  audioRecognition: {
    currentTranscript?: string;
  };
  _currentSpeech: { interrupted: boolean; allowInterruptions: boolean };
  pendingInterruption?: OverlappingSpeechEvent;
  interruptByAudioActivity: () => void;
};

type PausableInterruptionActivityHarness = InterruptionActivityHarness & {
  agentSession: InterruptionActivityHarness['agentSession'] & {
    agentState: 'listening';
    output: { audio: { pause: ReturnType<typeof vi.fn> } };
  };
  _currentSpeech: InterruptionActivityHarness['_currentSpeech'] & { id: string };
  cancelFalseInterruptionTimer: ReturnType<typeof vi.fn>;
  pauseEnabled: ReturnType<typeof vi.fn>;
};

function setActivityProp<T>(activity: object, key: string, value: T): void {
  Object.defineProperty(activity, key, { configurable: true, value, writable: true });
}

describe('realtime adaptive interruption', () => {
  it('pauses a resolved overlap with one agent speech end', () => {
    const onStartOfOverlapSpeech = vi.fn();
    const onEndOfAgentSpeech = vi.fn();
    const pause = vi.fn();
    let agentState: 'speaking' | 'listening' = 'speaking';
    const agentSession = {
      _aecWarmupRemaining: 0,
      _textOnly: true,
      _userSpeakingSpan: undefined,
      emit: vi.fn(),
      get agentState() {
        return agentState;
      },
      llm: new FakeLLM([]),
      output: { audio: { pause } },
      sessionOptions: {
        turnHandling: {
          interruption: { falseInterruptionTimeout: 2_000, minWords: 0 },
        },
      },
      _updateAgentState: vi.fn((state: 'listening') => {
        agentState = state;
      }),
    };
    const activity = Object.create(AgentActivity.prototype) as {
      onOverlapSpeech: AgentActivity['onOverlapSpeech'];
      audioRecognition: {
        applyOverlapSpeechEvent: ReturnType<typeof vi.fn>;
        currentTranscript: string;
        endpointingOverlapping: boolean;
        onStartOfOverlapSpeech: typeof onStartOfOverlapSpeech;
        onEndOfAgentSpeech: typeof onEndOfAgentSpeech;
      };
    };
    const applyOverlapSpeechEvent = vi.fn();
    Object.assign(activity, {
      _currentSpeech: { interrupted: false, allowInterruptions: true },
      agent: new Agent({ instructions: 'test' }),
      agentSession,
      audioRecognition: {
        applyOverlapSpeechEvent,
        currentTranscript: '',
        endpointingOverlapping: true,
        onStartOfOverlapSpeech,
        onEndOfAgentSpeech,
      },
      cancelFalseInterruptionTimer: vi.fn(),
      isInterruptionByAudioActivityEnabled: true,
      isInterruptionDetectionEnabled: true,
      pauseEnabled: () => true,
      restoreInterruptionByAudioActivity: vi.fn(() =>
        setActivityProp(activity, 'isInterruptionByAudioActivityEnabled', true),
      ),
      updatePausedSpeech: vi.fn(() => setActivityProp(activity, 'pausedSpeech', {})),
    });

    const event = overlapEvent({ isInterruption: true, agentEnded: false });
    activity.onOverlapSpeech(event);

    expect(pause).toHaveBeenCalledOnce();
    expect(applyOverlapSpeechEvent).toHaveBeenCalledWith(event);
    expect(onStartOfOverlapSpeech).not.toHaveBeenCalled();
    expect(onEndOfAgentSpeech).toHaveBeenCalledOnce();
  });

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

  it('owns the adaptive verdict transition', () => {
    const activity = Object.create(AgentActivity.prototype) as any;
    const calls: string[] = [];
    const event = overlapEvent({ isInterruption: true });
    activity.pendingInterruption = undefined;
    activity.isInterruptionByAudioActivityEnabled = true;
    activity.audioRecognition = {
      applyOverlapSpeechEvent: vi.fn((ev: OverlappingSpeechEvent) => {
        expect(ev).toBe(event);
        expect(activity.pendingInterruption).toBe(event);
        expect(activity.isInterruptionByAudioActivityEnabled).toBe(false);
        calls.push('apply');
      }),
    };
    activity.agentSession = { emit: vi.fn() };
    activity.restoreInterruptionByAudioActivity = vi.fn(() => calls.push('restore'));
    activity.interruptByAudioActivity = vi.fn(() => calls.push('interrupt'));

    activity.onOverlapSpeech(event);

    expect(calls).toEqual(['apply', 'restore', 'interrupt']);
    expect(activity.pendingInterruption).toBe(event);
    expect(activity.agentSession.emit).toHaveBeenCalledWith('overlapping_speech', event);
    expect(activity.interruptByAudioActivity).toHaveBeenCalledWith();
  });

  it('waits for enough transcript words before interrupting', () => {
    const activity = Object.create(AgentActivity.prototype) as any;
    activity.isInterruptionByAudioActivityEnabled = true;
    activity.agent = { _llm: {}, _stt: {} };
    activity.agentSession = {
      _textOnly: false,
      _aecWarmupRemaining: 0,
      sessionOptions: {
        turnHandling: {
          interruption: { minWords: 2 },
        },
      },
    };
    activity.audioRecognition = {
      currentTranscript: 'one',
    };
    activity._currentSpeech = {
      id: 'speech',
      interrupted: false,
      allowInterruptions: true,
      interrupt: vi.fn(),
    };
    activity.pendingInterruption = overlapEvent({ isInterruption: true });
    activity.cancelFalseInterruptionTimer = vi.fn();
    activity.pauseEnabled = vi.fn(() => false);
    activity.logger = { info: vi.fn() };

    activity.interruptByAudioActivity();

    expect(activity._currentSpeech.interrupt).not.toHaveBeenCalled();
    expect(activity.pendingInterruption).toBeDefined();

    activity.audioRecognition.currentTranscript = 'enough words';
    activity.interruptByAudioActivity();

    expect(activity._currentSpeech.interrupt).toHaveBeenCalledOnce();
    expect(activity.pendingInterruption).toBeDefined();
    expect(activity.audioActivityInterruptionInProgress).toBe(false);
  });

  it('keeps a pending verdict when the transcript is below minWords', () => {
    const activity = Object.create(
      AgentActivity.prototype,
    ) as unknown as InterruptionActivityHarness;
    activity.isInterruptionByAudioActivityEnabled = true;
    activity.agent = { _llm: {}, _stt: {} };
    activity.agentSession = {
      _textOnly: false,
      _aecWarmupRemaining: 0,
      sessionOptions: {
        turnHandling: {
          interruption: { minWords: 2 },
        },
      },
    };
    activity.audioRecognition = {
      currentTranscript: 'one',
    };
    activity._currentSpeech = {
      interrupted: false,
      allowInterruptions: true,
    };
    activity.pendingInterruption = overlapEvent({ isInterruption: true });

    activity.interruptByAudioActivity();

    expect(activity.pendingInterruption).toBeDefined();
  });

  it('keeps a pending verdict during AEC warmup', () => {
    const activity = Object.create(
      AgentActivity.prototype,
    ) as unknown as InterruptionActivityHarness;
    activity.isInterruptionByAudioActivityEnabled = true;
    activity.agent = { _llm: {}, _stt: undefined };
    activity.agentSession = {
      _textOnly: false,
      _aecWarmupRemaining: 1,
      sessionOptions: {
        turnHandling: {
          interruption: { minWords: 0 },
        },
      },
    };
    activity.audioRecognition = {};
    activity._currentSpeech = {
      interrupted: false,
      allowInterruptions: true,
    };
    activity.pendingInterruption = overlapEvent({ isInterruption: true });

    activity.interruptByAudioActivity();

    expect(activity.pendingInterruption).toBeDefined();
  });

  it('clears a pending verdict when no speech can be interrupted', () => {
    const activity = Object.create(AgentActivity.prototype) as any;
    activity.isInterruptionByAudioActivityEnabled = true;
    activity.agent = { _llm: {}, _stt: undefined };
    activity.agentSession = {
      _textOnly: false,
      _aecWarmupRemaining: 0,
      sessionOptions: {
        turnHandling: {
          interruption: { minWords: 0 },
        },
      },
    };
    activity.audioRecognition = {};
    activity._currentSpeech = undefined;
    activity.pendingInterruption = overlapEvent({ isInterruption: true });

    activity.interruptByAudioActivity();

    expect(activity.pendingInterruption).toBeUndefined();
  });

  it('keeps a pending verdict until an interrupted speech ends', () => {
    const activity = Object.create(
      AgentActivity.prototype,
    ) as unknown as InterruptionActivityHarness;
    activity.isInterruptionByAudioActivityEnabled = true;
    activity.agent = { _llm: {}, _stt: undefined };
    activity.agentSession = {
      _textOnly: false,
      _aecWarmupRemaining: 0,
      sessionOptions: {
        turnHandling: {
          interruption: { minWords: 0 },
        },
      },
    };
    activity.audioRecognition = {};
    activity._currentSpeech = {
      interrupted: true,
      allowInterruptions: true,
    };
    activity.pendingInterruption = overlapEvent({ isInterruption: true });

    activity.interruptByAudioActivity();

    expect(activity.pendingInterruption).toBeDefined();
  });

  it('clears a pending verdict when speech is already paused', () => {
    const activity = Object.create(
      AgentActivity.prototype,
    ) as unknown as PausableInterruptionActivityHarness;
    activity.isInterruptionByAudioActivityEnabled = true;
    activity.agent = { _llm: {}, _stt: undefined };
    activity.agentSession = {
      _textOnly: false,
      _aecWarmupRemaining: 0,
      agentState: 'listening',
      output: { audio: { pause: vi.fn() } },
      sessionOptions: {
        turnHandling: {
          interruption: { minWords: 0 },
        },
      },
    };
    activity.audioRecognition = {};
    activity._currentSpeech = {
      id: 'speech',
      interrupted: false,
      allowInterruptions: true,
    };
    activity.pendingInterruption = overlapEvent({ isInterruption: true });
    activity.cancelFalseInterruptionTimer = vi.fn();
    activity.pauseEnabled = vi.fn(() => true);

    activity.interruptByAudioActivity();

    expect(activity.agentSession.output.audio.pause).toHaveBeenCalledOnce();
    expect(activity.pendingInterruption).toBeUndefined();
  });

  it('preserves a pending positive verdict when a held start event is replayed', () => {
    const activity = Object.create(AgentActivity.prototype) as any;
    activity.agentSession = {
      agentState: 'speaking',
      _userSpeakingSpan: undefined,
      _updateUserState: vi.fn(),
      amd: undefined,
    };
    activity.audioRecognition = {
      onStartOfOverlapSpeech: vi.fn(),
    };
    activity.pendingInterruption = overlapEvent({ isInterruption: true });
    activity.isInterruptionDetectionEnabled = true;
    activity.userSilenceEvent = { clear: vi.fn() };
    activity.cancelFalseInterruptionTimer = vi.fn();
    activity.pauseEnabled = vi.fn(() => false);

    activity.onStartOfSpeech({ speechDuration: 0, inferenceDuration: 0 } as any);

    expect(activity.audioRecognition.onStartOfOverlapSpeech).not.toHaveBeenCalled();
  });

  it('clears a pending verdict after recognition teardown starts', () => {
    const activity = Object.create(AgentActivity.prototype) as any;
    const event = overlapEvent({ isInterruption: true });
    activity.pendingInterruption = event;
    activity.audioRecognition = {
      onEndOfAgentSpeech: vi.fn((endedAt: number) => {
        expect(endedAt).toBe(10_000);
        expect(activity.pendingInterruption).toBe(event);
        return Promise.resolve();
      }),
    };

    activity.onEndOfAgentSpeech(10_000);

    expect(activity.pendingInterruption).toBeUndefined();
  });

  it('keeps audio activity enabled for active user speech with a zero boundary', () => {
    const activity = Object.create(AgentActivity.prototype) as unknown as {
      audioRecognition: { backchannelBoundaryActive: boolean; userSpeaking: boolean };
      isInterruptionByAudioActivityEnabled: boolean;
      disableVadInterruptionSoon: () => void;
    };
    activity.audioRecognition = {
      backchannelBoundaryActive: false,
      userSpeaking: true,
    };
    activity.isInterruptionByAudioActivityEnabled = true;

    activity.disableVadInterruptionSoon();

    expect(activity.isInterruptionByAudioActivityEnabled).toBe(true);
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

  it('commits an unjudged overlap over a paused speech', async () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'k');
    vi.stubEnv('LIVEKIT_API_SECRET', 's');

    const activity = makeActivity(realtimeBargeInSession()) as unknown as ActivityInternals;
    activity._schedulingPaused = false;
    activity._currentSpeech = SpeechHandle.create({ allowInterruptions: true });
    activity.pausedSpeech = {
      handle: activity._currentSpeech,
      agentState: 'speaking',
      timeout: 2000,
    };
    activity.createSpeechTask = vi.fn(() => ({}));

    expect(await activity.onEndOfTurn(endOfTurnInfo())).toBe(true);
  });

  it('drops a confirmed backchannel while agent speech is live', async () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'k');
    vi.stubEnv('LIVEKIT_API_SECRET', 's');

    const activity = makeActivity(realtimeBargeInSession()) as unknown as ActivityInternals;
    activity._schedulingPaused = false;
    activity._currentSpeech = SpeechHandle.create({ allowInterruptions: true });

    expect(await activity.onEndOfTurn(endOfTurnInfo({ backchannelOverAgent: true }))).toBe(false);
  });

  it('drops confirmed backchannels after agent speech finishes', async () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'k');
    vi.stubEnv('LIVEKIT_API_SECRET', 's');

    const activity = makeActivity(realtimeBargeInSession()) as unknown as ActivityInternals;
    activity._schedulingPaused = false;
    activity._currentSpeech = undefined;

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
  isAgentSpeaking: boolean;
  agentSpeechStartedAt?: number;
  activeVadSpeechStartedAt?: number;
  transcriptGateActive: boolean;
  transcriptBuffer: Array<{ createdAt?: number }>;
  backchannelBoundary?: [number, number];
  backchannelBoundaryTimer?: ReturnType<typeof setTimeout>;
  overlapInCurrentTurn: boolean;
  turnBackchannelOverAgent: boolean;
  speaking: boolean;
  hooks: {
    interruptionByAudioActivityEnabled: boolean;
    onBackchannelConfirmed: ReturnType<typeof vi.fn>;
  };
  processSTTEvent: ReturnType<typeof vi.fn>;
  applyOverlapSpeechEvent: (ev: OverlappingSpeechEvent) => void;
};

type RecognitionStreamInternals = AudioRecognition & {
  interruptionDetected?: boolean;
  overlapOpen: boolean;
  transcriptGateActive: boolean;
  speaking: boolean;
  turnBackchannelOverAgent: boolean;
  hooks: { interruptionByAudioActivityEnabled: boolean };
  trySendInterruptionSentinel: ReturnType<typeof vi.fn>;
};

function recognitionForOverlap(options: { speaking?: boolean } = {}): RecognitionInternals {
  const recognition = Object.create(AudioRecognition.prototype) as RecognitionInternals;
  Object.assign(recognition, {
    isAgentSpeaking: false,
    agentSpeechStartedAt: undefined,
    activeVadSpeechStartedAt: undefined,
    transcriptGateActive: false,
    transcriptBuffer: [],
    backchannelBoundary: undefined,
    backchannelBoundaryTimer: undefined,
    overlapInCurrentTurn: true,
    turnBackchannelOverAgent: false,
    speaking: options.speaking ?? false,
    hooks: {
      interruptionByAudioActivityEnabled: false,
      onBackchannelConfirmed: vi.fn(),
    },
    logger: { trace: vi.fn() },
  });
  return recognition;
}

function overlapEvent(options: {
  isInterruption: boolean;
  agentEnded?: boolean;
  detectedAt?: number;
  overlapStartedAt?: number;
}): OverlappingSpeechEvent {
  return {
    type: 'overlapping_speech',
    detectedAt: options.detectedAt ?? Date.now(),
    isInterruption: options.isInterruption,
    agentEnded: options.agentEnded,
    overlapStartedAt: options.overlapStartedAt,
    totalDurationInS: 0,
    predictionDurationInS: 0,
    detectionDelayInS: 0,
    probability: options.isInterruption ? 1 : 0,
    numRequests: 0,
  };
}

function recognitionWithInterruptionStream(): {
  recognition: RecognitionStreamInternals;
  sent: InterruptionSentinel[];
} {
  const recognition = Object.create(AudioRecognition.prototype) as RecognitionStreamInternals;
  const sent: InterruptionSentinel[] = [];
  Object.assign(recognition, {
    isInterruptionEnabled: true,
    isAgentSpeaking: false,
    agentSpeechStartedAt: undefined,
    activeVadSpeechStartedAt: undefined,
    transcriptGateActive: false,
    endpointing: {
      overlapping: false,
      onStartOfAgentSpeech: vi.fn(() => {
        recognition.endpointing.overlapping = false;
      }),
      onEndOfAgentSpeech: vi.fn(() => {
        recognition.endpointing.overlapping = false;
      }),
      onStartOfSpeech: vi.fn(() => {
        recognition.endpointing.overlapping = true;
      }),
    },
    backchannelBoundary: undefined,
    backchannelBoundaryTimer: undefined,
    backchannelBoundaryCallback: undefined,
    interruptionDetected: undefined,
    overlapInCurrentTurn: false,
    overlapOpen: false,
    speaking: false,
    turnBackchannelOverAgent: false,
    transcriptBuffer: [],
    hooks: {
      interruptionByAudioActivityEnabled: false,
      onOverlapSpeech: vi.fn(),
      onBackchannelConfirmed: vi.fn(),
    },
    logger: { trace: vi.fn() },
    trySendInterruptionSentinel: vi.fn(
      async (item: InterruptionSentinel | InterruptionSentinel[]) => {
        sent.push(...(Array.isArray(item) ? item : [item]));
        return true;
      },
    ),
  });
  return { recognition, sent };
}

describe('AudioRecognition realtime adaptive backchannel verdicts', () => {
  it('latches user-ended overlap as a backchannel', () => {
    const recognition = recognitionForOverlap();
    recognition.applyOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: false }));
    expect(recognition.turnBackchannelOverAgent).toBe(true);
  });

  it('trims a finished backchannel after a negative verdict', () => {
    const recognition = recognitionForOverlap();
    const oldEvent = { createdAt: 8_000 };
    const recentEvent = { createdAt: 9_500 };
    recognition.isAgentSpeaking = true;
    recognition.transcriptGateActive = true;
    recognition.backchannelBoundary = [0, 1_000];
    recognition.transcriptBuffer = [oldEvent, recentEvent];

    recognition.applyOverlapSpeechEvent(
      overlapEvent({ isInterruption: false, detectedAt: 10_000 }),
    );

    expect(recognition.transcriptBuffer).toEqual([recentEvent]);
  });

  it('preserves held transcripts when the start boundary falls back to VAD', () => {
    const recognition = recognitionForOverlap();
    const earlyEvent = { createdAt: 9_000 };
    const recentEvent = { createdAt: 9_750 };
    recognition.isAgentSpeaking = true;
    recognition.agentSpeechStartedAt = 9_000;
    recognition.transcriptGateActive = true;
    recognition.backchannelBoundary = [3_000, 500];
    recognition.backchannelBoundaryTimer = setTimeout(() => {}, 60_000);
    recognition.transcriptBuffer = [earlyEvent, recentEvent];

    try {
      recognition.applyOverlapSpeechEvent(
        overlapEvent({ isInterruption: false, detectedAt: 10_000 }),
      );

      expect(recognition.transcriptBuffer).toEqual([earlyEvent, recentEvent]);
    } finally {
      clearTimeout(recognition.backchannelBoundaryTimer);
    }
  });

  it('clears audio for confirmed backchannel between segments', () => {
    const recognition = recognitionForOverlap({ speaking: false });
    recognition.applyOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: false }));
    expect(recognition.hooks.onBackchannelConfirmed).toHaveBeenCalledOnce();
  });

  it('defers audio clear for confirmed backchannel while user is speaking', () => {
    const recognition = recognitionForOverlap({ speaking: true });
    recognition.applyOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: false }));
    expect(recognition.turnBackchannelOverAgent).toBe(true);
    expect(recognition.hooks.onBackchannelConfirmed).not.toHaveBeenCalled();
  });

  it('does not treat agent-ended overlap as a backchannel', () => {
    const recognition = recognitionForOverlap();
    recognition.applyOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: true }));
    expect(recognition.turnBackchannelOverAgent).toBe(false);
    expect(recognition.hooks.onBackchannelConfirmed).not.toHaveBeenCalled();
  });

  it('preserves a prior backchannel when a later agent-ended overlap arrives', () => {
    const recognition = recognitionForOverlap();
    recognition.turnBackchannelOverAgent = true;
    recognition.applyOverlapSpeechEvent(overlapEvent({ isInterruption: false, agentEnded: true }));
    expect(recognition.turnBackchannelOverAgent).toBe(true);
  });

  it('clears backchannel verdict on interruption', () => {
    const recognition = recognitionForOverlap();
    recognition.turnBackchannelOverAgent = true;
    recognition.applyOverlapSpeechEvent(overlapEvent({ isInterruption: true, agentEnded: false }));
    expect(recognition.turnBackchannelOverAgent).toBe(false);
    expect(recognition.hooks.onBackchannelConfirmed).not.toHaveBeenCalled();
  });

  it('closes overlap before resetting inference when agent speech ends', async () => {
    const { recognition, sent } = recognitionWithInterruptionStream();
    await recognition.onStartOfAgentSpeech(Date.now());
    await recognition.onStartOfOverlapSpeech(0, Date.now());
    sent.length = 0;

    await recognition.onEndOfAgentSpeech(Date.now());

    expect(sent.map((item) => item.type)).toEqual(['overlap-speech-ended', 'agent-speech-ended']);
    expect(sent[0]).toMatchObject({ agentEnded: true });
    expect(recognition.overlapOpen).toBe(false);
  });

  it('does not close overlap again when user speech ends after agent speech', async () => {
    const { recognition, sent } = recognitionWithInterruptionStream();
    await recognition.onStartOfAgentSpeech(Date.now());
    await recognition.onStartOfOverlapSpeech(0, Date.now());
    await recognition.onEndOfAgentSpeech(Date.now());
    sent.length = 0;

    await recognition.onEndOfOverlapSpeech(Date.now());

    expect(sent).toEqual([]);
  });

  it('keeps resumed speech with an active user on audio activity', async () => {
    const { recognition, sent } = recognitionWithInterruptionStream();
    await recognition.onStartOfAgentSpeech(Date.now());
    const userStartedAt = Date.now();
    recognition.speaking = true;
    await recognition.onStartOfOverlapSpeech(0, userStartedAt);
    await recognition.onEndOfAgentSpeech(Date.now());
    recognition.interruptionDetected = false;
    recognition.turnBackchannelOverAgent = true;
    sent.length = 0;
    recognition.hooks.interruptionByAudioActivityEnabled = true;

    const resumedAt = Date.now();
    await recognition.onStartOfAgentSpeech(resumedAt);

    expect(sent.map((item) => item.type)).toEqual(['agent-speech-started']);
    expect(recognition.hooks.interruptionByAudioActivityEnabled).toBe(true);
    expect(recognition.transcriptGateActive).toBe(false);
    expect(recognition.endpointing.onStartOfSpeech).toHaveBeenCalledOnce();
    expect(recognition.endpointing.onStartOfSpeech).toHaveBeenCalledWith(userStartedAt, true);
  });

  it('does not start the same overlap twice when a speech-start event follows agent speech', async () => {
    const { recognition, sent } = recognitionWithInterruptionStream();
    recognition.speaking = true;

    await recognition.onStartOfAgentSpeech(1_200);
    await recognition.onStartOfOverlapSpeech(200, 1_000);

    expect(sent.map((item) => item.type)).toEqual([
      'agent-speech-started',
      'overlap-speech-started',
    ]);
  });

  it('does not close an overlap again after a verdict resolves it', async () => {
    const { recognition, sent } = recognitionWithInterruptionStream();
    await recognition.onStartOfAgentSpeech(Date.now());
    await recognition.onStartOfOverlapSpeech(0, Date.now());
    recognition.applyOverlapSpeechEvent(overlapEvent({ isInterruption: true, agentEnded: false }));
    sent.length = 0;

    await recognition.onEndOfOverlapSpeech(Date.now());

    expect(sent).toEqual([]);
  });

  it('does not reopen overlap while replaying transcripts for a positive verdict', () => {
    const { recognition, sent } = recognitionWithInterruptionStream();
    const internals = recognition as any;
    internals.isAgentSpeaking = true;
    internals.agentSpeechStartedAt = 9_000;
    internals.overlapInCurrentTurn = true;
    internals.overlapOpen = true;
    internals.transcriptGateActive = true;
    internals.transcriptBuffer = [{ createdAt: 9_500 }];
    internals.processSTTEvent = vi.fn();

    const event = overlapEvent({
      isInterruption: true,
      detectedAt: 10_000,
      overlapStartedAt: 9_000,
    });
    internals.applyOverlapSpeechEvent(event);

    expect(internals.overlapOpen).toBe(false);
    expect(internals.transcriptGateActive).toBe(false);
    expect(internals.processSTTEvent).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
  });
  it('still tears down inference at the real end of agent speech', async () => {
    const { recognition, sent } = recognitionWithInterruptionStream();
    await recognition.onStartOfAgentSpeech(Date.now());
    await recognition.onStartOfOverlapSpeech(0, Date.now());
    sent.length = 0;

    await recognition.onEndOfAgentSpeech(Date.now());

    expect(sent.map((item) => item.type)).toEqual(['overlap-speech-ended', 'agent-speech-ended']);
    expect(sent[0]).toMatchObject({ agentEnded: true });
  });
});
