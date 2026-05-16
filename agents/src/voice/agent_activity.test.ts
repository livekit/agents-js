// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for mainTask speech handle processing.
 *
 * When a speech handle is interrupted after _authorizeGeneration() but before the
 * reply task calls _markGenerationDone(), mainTask hangs on _waitForGeneration()
 * indefinitely. All subsequent speech handles queue behind it and the agent becomes
 * unresponsive.
 *
 * Fix: race _waitForGeneration() against the interrupt future via waitIfNotInterrupted().
 *
 * Related: #1124, #1089, #836
 */
import { Heap } from 'heap-js';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { LLM, type LLMStream } from '../llm/llm.js';
import { Future } from '../utils.js';
import { type VADEvent, VADEventType } from '../vad.js';
import { AgentActivity } from './agent_activity.js';
import type { PreemptiveGenerationInfo } from './audio_recognition.js';
import { SpeechHandle } from './speech_handle.js';

// Break circular dependency: agent_activity.ts → agent.js → beta/workflows/task_group.ts
vi.mock('./agent.js', () => {
  class Agent {}
  class AgentTask extends Agent {}
  class StopResponse {}
  return {
    Agent,
    AgentTask,
    StopResponse,
    _getActivityTaskInfo: () => null,
    _setActivityTaskInfo: () => {},
    functionCallStorage: {
      getStore: () => undefined,
      enterWith: () => {},
      run: (_: unknown, fn: () => unknown) => fn(),
    },
    speechHandleStorage: {
      getStore: () => undefined,
      enterWith: () => {},
    },
  };
});

vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

async function raceTimeout(promise: Promise<unknown>, ms: number): Promise<'resolved' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise.then(() => 'resolved' as const), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Build a minimal stand-in with just enough state for mainTask to run.
 *
 * mainTask accesses: q_updated, speechQueue, _currentSpeech, _schedulingPaused,
 * getDrainPendingSpeechTasks(), and logger. We provide stubs for all of these,
 * then bind the real AgentActivity.prototype.mainTask to this object.
 */
function buildMainTaskRunner() {
  const q_updated = new Future<void>();
  type HeapItem = [number, number, SpeechHandle];
  const speechQueue = new Heap<HeapItem>((a: HeapItem, b: HeapItem) => b[0] - a[0] || a[1] - b[1]);

  const fakeActivity = {
    q_updated,
    speechQueue,
    _currentSpeech: undefined as SpeechHandle | undefined,
    _schedulingPaused: false,
    _authorizationPaused: false,
    getDrainPendingSpeechTasks: () => [],
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  const mainTask = (AgentActivity.prototype as Record<string, unknown>).mainTask as (
    signal: AbortSignal,
  ) => Promise<void>;

  return {
    fakeActivity,
    mainTask: mainTask.bind(fakeActivity),
    speechQueue,
    q_updated,
  };
}

function buildVadInterruptionRunner() {
  const audioOutput = {
    canPause: true,
    pause: vi.fn(),
    resume: vi.fn(),
  };
  const audioRecognition = {
    onEndOfAgentSpeech: vi.fn(),
    cancelBackchannelBoundary: vi.fn(),
  };
  const speechHandle = SpeechHandle.create({ allowInterruptions: true });

  const fakeActivity: Record<string, unknown> = {
    turnDetection: 'vad',
    isInterruptionByAudioActivityEnabled: true,
    isDefaultInterruptionByAudioActivityEnabled: true,
    isInterruptionDetectionEnabled: false,
    _currentSpeech: speechHandle,
    stt: undefined,
    llm: undefined,
    realtimeSession: undefined,
    audioRecognition,
    falseInterruptionTimer: undefined,
    pausedSpeech: undefined,
    agentSession: {
      agentState: 'speaking',
      _aecWarmupRemaining: 0,
      _userSpeakingSpan: undefined,
      output: { audio: audioOutput },
      sessionOptions: {
        turnHandling: {
          interruption: {
            minDuration: 0,
            minWords: 0,
            resumeFalseInterruption: true,
            falseInterruptionTimeout: 500,
          },
        },
      },
      _updateAgentState: vi.fn((state: string) => {
        (fakeActivity.agentSession as { agentState: string }).agentState = state;
      }),
    },
  };
  Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);

  const vadEvent: VADEvent = {
    type: VADEventType.INFERENCE_DONE,
    samplesIndex: 0,
    timestamp: Date.now(),
    speechDuration: 1,
    silenceDuration: 0,
    frames: [],
    probability: 1,
    inferenceDuration: 0,
    speaking: true,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 1,
  };

  return { fakeActivity, audioOutput, audioRecognition, vadEvent };
}

describe('AgentActivity - mainTask', () => {
  it('should recover when speech handle is interrupted after authorization', async () => {
    const { fakeActivity, mainTask, speechQueue, q_updated } = buildMainTaskRunner();

    const handle = SpeechHandle.create({ allowInterruptions: true });

    speechQueue.push([SpeechHandle.SPEECH_PRIORITY_NORMAL, 1, handle]);
    handle._markScheduled();
    q_updated.resolve();

    const ac = new AbortController();
    const mainTaskPromise = mainTask(ac.signal);

    // Give mainTask time to pop the handle and call _authorizeGeneration
    await new Promise((r) => setTimeout(r, 50));

    // Interrupt while waiting for generation
    handle.interrupt();

    // Let mainTask react to the interrupt, then signal exit
    await new Promise((r) => setTimeout(r, 50));
    fakeActivity._schedulingPaused = true;
    fakeActivity.q_updated = new Future();
    fakeActivity.q_updated.resolve();
    ac.abort();

    const result = await raceTimeout(mainTaskPromise, 2000);
    expect(result).toBe('resolved');
  });

  it('should process next queued handle after an interrupted one', async () => {
    const { fakeActivity, mainTask, speechQueue, q_updated } = buildMainTaskRunner();

    const handleA = SpeechHandle.create({ allowInterruptions: true });
    const handleB = SpeechHandle.create({ allowInterruptions: true });

    speechQueue.push([SpeechHandle.SPEECH_PRIORITY_NORMAL, 1, handleA]);
    handleA._markScheduled();
    speechQueue.push([SpeechHandle.SPEECH_PRIORITY_NORMAL, 2, handleB]);
    handleB._markScheduled();
    q_updated.resolve();

    const ac = new AbortController();
    const mainTaskPromise = mainTask(ac.signal);

    // Wait for mainTask to pick up handle A
    await new Promise((r) => setTimeout(r, 50));

    // Interrupt handle A
    handleA.interrupt();

    // Wait for mainTask to move to handle B and authorize it
    await new Promise((r) => setTimeout(r, 50));

    // Resolve handle B's generation (simulating normal reply task completion).
    // If mainTask is stuck on handle A (bug), handle B was never authorized and this
    // throws — we catch it and let the timeout assert the real failure.
    try {
      handleB._markGenerationDone();
    } catch {
      // Expected when fix is absent: handle B has no active generation
    }

    // Let mainTask finish
    await new Promise((r) => setTimeout(r, 50));
    fakeActivity._schedulingPaused = true;
    fakeActivity.q_updated = new Future();
    fakeActivity.q_updated.resolve();
    ac.abort();

    const result = await raceTimeout(mainTaskPromise, 2000);
    expect(result).toBe('resolved');
  });

  it('should skip handles that were interrupted before being popped', async () => {
    const { fakeActivity, mainTask, speechQueue, q_updated } = buildMainTaskRunner();

    const handle = SpeechHandle.create({ allowInterruptions: true });

    // Interrupt before mainTask ever sees it
    handle.interrupt();

    speechQueue.push([SpeechHandle.SPEECH_PRIORITY_NORMAL, 1, handle]);
    handle._markScheduled();
    q_updated.resolve();

    const ac = new AbortController();
    const mainTaskPromise = mainTask(ac.signal);

    await new Promise((r) => setTimeout(r, 50));
    fakeActivity._schedulingPaused = true;
    fakeActivity.q_updated = new Future();
    fakeActivity.q_updated.resolve();
    ac.abort();

    const result = await raceTimeout(mainTaskPromise, 2000);
    expect(result).toBe('resolved');
  });

  it('should hold queued speech while reply authorization is paused', async () => {
    const { fakeActivity, mainTask, speechQueue, q_updated } = buildMainTaskRunner();

    const handle = SpeechHandle.create({ allowInterruptions: true });
    fakeActivity._authorizationPaused = true;

    speechQueue.push([SpeechHandle.SPEECH_PRIORITY_NORMAL, 1, handle]);
    handle._markScheduled();
    q_updated.resolve();

    const ac = new AbortController();
    const mainTaskPromise = mainTask(ac.signal);

    await new Promise((r) => setTimeout(r, 50));
    expect(() => handle._markGenerationDone()).toThrow(
      'cannot use mark_generation_done: no active generation is running.',
    );

    fakeActivity._authorizationPaused = false;
    fakeActivity.q_updated.resolve();

    await new Promise((r) => setTimeout(r, 50));
    expect(() => handle._markGenerationDone()).not.toThrow();

    fakeActivity._schedulingPaused = true;
    fakeActivity.q_updated = new Future();
    fakeActivity.q_updated.resolve();
    ac.abort();

    const result = await raceTimeout(mainTaskPromise, 2000);
    expect(result).toBe('resolved');
  });
});

describe('AgentActivity - VAD interruption', () => {
  it('ends agent speech once when repeated VAD inference pauses the same speech', () => {
    const { fakeActivity, audioOutput, audioRecognition, vadEvent } = buildVadInterruptionRunner();

    fakeActivity.onVADInferenceDone(vadEvent);
    fakeActivity.onVADInferenceDone(vadEvent);

    expect(audioOutput.pause).toHaveBeenCalledTimes(1);
    expect(audioRecognition.onEndOfAgentSpeech).toHaveBeenCalledTimes(1);
    expect((fakeActivity.agentSession as { agentState: string }).agentState).toBe('listening');
  });
});

describe('AgentActivity - speech completion', () => {
  it('ends audio recognition speech when pipeline completion moves session out of speaking', () => {
    const audioRecognition = {
      onEndOfAgentSpeech: vi.fn(),
    };
    const fakeActivity = {
      speechQueue: {
        peek: () => undefined,
      },
      _currentSpeech: {
        done: () => true,
      },
      audioRecognition,
      agentSession: {
        agentState: 'speaking',
        _updateAgentState: vi.fn((state: string) => {
          fakeActivity.agentSession.agentState = state;
        }),
      },
    };

    const onPipelineReplyDone = (AgentActivity.prototype as Record<string, unknown>)
      .onPipelineReplyDone as (this: typeof fakeActivity) => void;

    onPipelineReplyDone.call(fakeActivity);

    expect(fakeActivity.agentSession._updateAgentState).toHaveBeenCalledWith('listening');
    expect(audioRecognition.onEndOfAgentSpeech).toHaveBeenCalledTimes(1);
  });
});

describe('AgentActivity - confirmed interruptions', () => {
  it('ends audio recognition when confirmed interruption only has paused speech', () => {
    const pausedSpeech = SpeechHandle.create({ allowInterruptions: true });

    const fakeActivity: Record<string, unknown> = {
      restoreInterruptionByAudioActivity: vi.fn(),
      interruptByAudioActivity: vi.fn(() => false),
      _currentSpeech: undefined,
      pausedSpeech: { handle: pausedSpeech },
      falseInterruptionTimer: undefined,
      audioRecognition: {
        onEndOfAgentSpeech: vi.fn(),
      },
      agentSession: {
        agentState: 'listening',
      },
    };
    Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);

    const onInterruption = (AgentActivity.prototype as Record<string, unknown>).onInterruption as (
      this: typeof fakeActivity,
      ev: Parameters<AgentActivity['onInterruption']>[0],
    ) => void;

    onInterruption.call(fakeActivity, {
      type: 'overlapping_speech',
      detectedAt: Date.now(),
      isInterruption: true,
    });

    expect(pausedSpeech.interrupted).toBe(true);
    expect(fakeActivity.pausedSpeech).toBeUndefined();
    expect(
      (
        fakeActivity.audioRecognition as {
          onEndOfAgentSpeech: ReturnType<typeof vi.fn>;
        }
      ).onEndOfAgentSpeech,
    ).toHaveBeenCalledTimes(1);
  });
});

/**
 * Unit tests for the preemptive-generation guards in AgentActivity.
 *
 * These tests drive AgentActivity.onPreemptiveGeneration directly against a
 * lightly-stubbed `this` context so we can exercise the `maxRetries` and
 * `maxSpeechDuration` guards deterministically, without needing real STT
 * preflight events or a live turn detector.
 */
class FakePreemptiveLLM extends LLM {
  label(): string {
    return 'fake.LLM';
  }
  chat(): LLMStream {
    throw new Error('not used in these tests');
  }
}

type PreemptiveOpts = {
  enabled: boolean;
  preemptiveTts: boolean;
  maxSpeechDuration: number;
  maxRetries: number;
};

function buildPreemptiveRunner(opts: Partial<PreemptiveOpts> = {}) {
  const preemptiveOpts: PreemptiveOpts = {
    enabled: true,
    preemptiveTts: false,
    maxSpeechDuration: 10_000,
    maxRetries: 3,
    ...opts,
  };

  const generateReply = vi.fn(
    () => ({ id: 'speech_fake', _cancel: () => {} }) as unknown as SpeechHandle,
  );
  const cancelPreemptiveGeneration = vi.fn();

  const fakeChatCtx = new ChatContext();

  const fakeActivity = {
    _preemptiveGenerationCount: 0,
    _preemptiveGeneration: undefined,
    _currentSpeech: undefined as SpeechHandle | undefined,
    schedulingPaused: false,
    llm: new FakePreemptiveLLM(),
    tools: {},
    toolChoice: null,
    agent: { chatCtx: fakeChatCtx },
    agentSession: {
      sessionOptions: {
        turnHandling: { preemptiveGeneration: preemptiveOpts },
      },
    },
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
    generateReply,
    cancelPreemptiveGeneration,
  };
  Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);

  const onPreemptiveGeneration = (AgentActivity.prototype as Record<string, unknown>)
    .onPreemptiveGeneration as (this: unknown, info: PreemptiveGenerationInfo) => void;

  return {
    fakeActivity,
    preemptiveOpts,
    generateReply,
    cancelPreemptiveGeneration,
    call: (info: Partial<PreemptiveGenerationInfo> = {}) =>
      onPreemptiveGeneration.call(fakeActivity, {
        newTranscript: 'hello world',
        transcriptConfidence: 0.95,
        startedSpeakingAt: undefined,
        ...info,
      }),
  };
}

describe('AgentActivity - onPreemptiveGeneration guards', () => {
  it('increments counter up to maxRetries then skips further calls within the same turn', () => {
    const { fakeActivity, generateReply, call } = buildPreemptiveRunner({ maxRetries: 2 });

    call();
    expect(fakeActivity._preemptiveGenerationCount).toBe(1);
    expect(generateReply).toHaveBeenCalledTimes(1);

    call();
    expect(fakeActivity._preemptiveGenerationCount).toBe(2);
    expect(generateReply).toHaveBeenCalledTimes(2);

    call();
    expect(fakeActivity._preemptiveGenerationCount).toBe(2);
    expect(generateReply).toHaveBeenCalledTimes(2);

    call();
    expect(fakeActivity._preemptiveGenerationCount).toBe(2);
    expect(generateReply).toHaveBeenCalledTimes(2);
  });

  it('resumes preemption after the counter is reset (simulates onEndOfTurn)', () => {
    const { fakeActivity, generateReply, call } = buildPreemptiveRunner({ maxRetries: 2 });

    call();
    call();
    call();
    expect(generateReply).toHaveBeenCalledTimes(2);

    fakeActivity._preemptiveGenerationCount = 0;

    call();
    expect(fakeActivity._preemptiveGenerationCount).toBe(1);
    expect(generateReply).toHaveBeenCalledTimes(3);
  });

  it('skips preemption when startedSpeakingAt exceeds maxSpeechDuration', () => {
    const { fakeActivity, generateReply, call } = buildPreemptiveRunner({
      maxSpeechDuration: 3000,
    });

    call({ startedSpeakingAt: Date.now() - 1000 });
    expect(fakeActivity._preemptiveGenerationCount).toBe(1);
    expect(generateReply).toHaveBeenCalledTimes(1);

    call({ startedSpeakingAt: Date.now() - 5000 });
    expect(fakeActivity._preemptiveGenerationCount).toBe(1);
    expect(generateReply).toHaveBeenCalledTimes(1);
  });

  it('skips preemption entirely when enabled is false', () => {
    const { fakeActivity, generateReply, cancelPreemptiveGeneration, call } = buildPreemptiveRunner(
      { enabled: false },
    );

    call();
    call();

    expect(fakeActivity._preemptiveGenerationCount).toBe(0);
    expect(generateReply).not.toHaveBeenCalled();
    expect(cancelPreemptiveGeneration).not.toHaveBeenCalled();
  });

  it('skips preemption while a paused speech is still active', () => {
    const { fakeActivity, generateReply, call } = buildPreemptiveRunner();
    const pausedSpeech = SpeechHandle.create({ allowInterruptions: true });

    fakeActivity.pausedSpeech = { handle: pausedSpeech };

    call();

    expect(fakeActivity._preemptiveGenerationCount).toBe(0);
    expect(generateReply).not.toHaveBeenCalled();
  });
});
