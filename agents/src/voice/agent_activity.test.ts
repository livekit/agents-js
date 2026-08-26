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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentConfigUpdate,
  ChatContext,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
} from '../llm/chat_context.js';
import { LLM, type LLMStream } from '../llm/llm.js';
import {
  type GenerationCreatedEvent,
  type RealtimeCapabilities,
  RealtimeError,
  RealtimeModel,
  type RealtimeSession,
} from '../llm/realtime.js';
import { type Tool, ToolContext, ToolFlag, Toolset, tool } from '../llm/tool_context.js';
import { log } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { Event, Future, Task } from '../utils.js';
import { AgentTask, _getActivityTaskInfo } from './agent.js';
import { AgentActivity, onEnterStorage, transcriptsEquivalent } from './agent_activity.js';
import type { EndOfTurnInfo, PreemptiveGenerationInfo } from './audio_recognition.js';
import { AgentSessionEventTypes, type UserInputTranscribedEvent } from './events.js';
import { ToolExecutionOutput } from './generation.js';
import { SpeechHandle } from './speech_handle.js';

const agentMocks = vi.hoisted(() => ({
  getActivityTaskInfo: vi.fn(() => null),
}));

// Break circular dependency: agent_activity.ts → agent.js → workflows/task_group.ts
vi.mock('./agent.js', () => {
  class Agent {}
  class AgentTask extends Agent {}
  class StopResponse {}
  return {
    Agent,
    AgentTask,
    StopResponse,
    _getActivityTaskInfo: agentMocks.getActivityTaskInfo,
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
  const speechTasks = new Set<Task<void>>();

  const fakeActivity: {
    q_updated: Future<void>;
    speechQueue: Heap<HeapItem>;
    speechTasks: Set<Task<void>>;
    _currentSpeech: SpeechHandle | undefined;
    _schedulingPaused: boolean;
    _authorizationPaused: boolean;
    _drainBlockedTasks: Set<Task<void>>;
    _mainTask: { result: Promise<void> } | undefined;
    logger: {
      info: () => void;
      debug: () => void;
      warn: () => void;
      error: () => void;
    };
    getDrainPendingSpeechTasks?: () => Task<void>[];
    wakeupMainTask?: () => void;
  } = {
    q_updated,
    speechQueue,
    speechTasks,
    _currentSpeech: undefined as SpeechHandle | undefined,
    _schedulingPaused: false,
    _authorizationPaused: false,
    _drainBlockedTasks: new Set<Task<void>>(),
    _mainTask: undefined as { result: Promise<void> } | undefined,
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  const proto = AgentActivity.prototype as unknown as Record<string, unknown>;
  fakeActivity.getDrainPendingSpeechTasks = (
    proto.getDrainPendingSpeechTasks as () => Task<void>[]
  ).bind(fakeActivity);
  fakeActivity.wakeupMainTask = (proto.wakeupMainTask as () => void).bind(fakeActivity);

  const mainTask = proto.mainTask as (signal: AbortSignal) => Promise<void>;
  const pauseSchedulingTask = proto._pauseSchedulingTask as (
    blockedTasks: Task<void>[],
  ) => Promise<void>;

  return {
    fakeActivity,
    mainTask: mainTask.bind(fakeActivity),
    pauseSchedulingTask: pauseSchedulingTask.bind(fakeActivity),
    speechQueue,
    speechTasks,
    q_updated,
  };
}

describe('AgentActivity - mainTask', () => {
  it('preserves realtime user input transcription item IDs', () => {
    const capturedEvents: UserInputTranscribedEvent[] = [];
    const activity = Object.create(AgentActivity.prototype) as AgentActivity;
    Object.assign(activity, {
      agentSession: {
        emit: (_type: AgentSessionEventTypes, ev: UserInputTranscribedEvent) => {
          capturedEvents.push(ev);
        },
      },
    });

    activity.onInputAudioTranscriptionCompleted({
      itemId: 'item_123',
      transcript: 'hello',
      isFinal: false,
    });

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]?.transcript).toBe('hello');
    expect(capturedEvents[0]?.isFinal).toBe(false);
    expect(capturedEvents[0]?.itemId).toBe('item_123');
  });

  it.each([
    { hasLocalVad: false, shouldInterrupt: true },
    { hasLocalVad: true, shouldInterrupt: false },
  ])(
    'interim transcript interrupts only without local VAD: $hasLocalVad',
    ({ hasLocalVad, shouldInterrupt }) => {
      const capturedEvents: UserInputTranscribedEvent[] = [];
      const interruptByAudioActivity = vi.fn();
      const activity = Object.assign(Object.create(AgentActivity.prototype), {
        agent: { llm: undefined, vad: undefined, turnHandling: undefined },
        agentSession: {
          _textOnly: false,
          llm: undefined,
          vad: hasLocalVad ? {} : undefined,
          turnDetection: undefined,
          emit: (_type: AgentSessionEventTypes, ev: UserInputTranscribedEvent) => {
            capturedEvents.push(ev);
          },
        },
        interruptByAudioActivity,
      });
      const ev: SpeechEvent = {
        type: SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives: [
          {
            text: 'hello',
            language: 'en',
            startTime: 0,
            endTime: 0,
            confidence: 1,
          },
        ],
      };

      (
        AgentActivity.prototype.onInterimTranscript as (
          this: unknown,
          ev: SpeechEvent,
          speaking: boolean | undefined,
        ) => void
      ).call(activity, ev, undefined);

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]?.transcript).toBe('hello');
      if (shouldInterrupt) {
        expect(interruptByAudioActivity).toHaveBeenCalledOnce();
      } else {
        expect(interruptByAudioActivity).not.toHaveBeenCalled();
      }
    },
  );

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

  it('interrupts queued speech behind a cancelled protected handle', () => {
    type HeapItem = [number, number, SpeechHandle];
    const speechQueue = new Heap<HeapItem>(
      (a: HeapItem, b: HeapItem) => b[0] - a[0] || a[1] - b[1],
    );
    const protectedHandle = SpeechHandle.create({ allowInterruptions: false });
    const behind = SpeechHandle.create({ allowInterruptions: true });
    speechQueue.push([SpeechHandle.SPEECH_PRIORITY_NORMAL, 1, protectedHandle]);
    speechQueue.push([SpeechHandle.SPEECH_PRIORITY_NORMAL, 2, behind]);
    protectedHandle.interrupt(true);

    const activity = Object.assign(Object.create(AgentActivity.prototype), {
      cancelPreemptiveGeneration: () => {},
      _interruptBackgroundSpeeches: () => [],
      _currentSpeech: undefined,
      speechQueue,
      realtimeSession: undefined,
    }) as AgentActivity;

    activity.interrupt();

    expect(behind.interrupted).toBe(true);
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

  it('does not deadlock when a drain runs from inside its own speech task', async () => {
    const { fakeActivity, mainTask, pauseSchedulingTask, speechTasks } = buildMainTaskRunner();

    const ac = new AbortController();
    const mainTaskPromise = mainTask(ac.signal);
    fakeActivity._mainTask = {
      result: mainTaskPromise,
    };

    // Let mainTask park on q_updated before the drain wakes it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const drain = Task.from(
      async () => {
        const current = Task.current() as Task<void>;
        speechTasks.add(current);
        await pauseSchedulingTask([]);
      },
      undefined,
      'reentrant-drain',
    );

    try {
      const result = await raceTimeout(drain.result, 2000);
      expect(result).toBe('resolved');
    } finally {
      speechTasks.clear();
      fakeActivity._schedulingPaused = true;
      fakeActivity.q_updated = new Future();
      fakeActivity.q_updated.resolve();
      ac.abort();
      await raceTimeout(mainTaskPromise, 2000);
    }
  });

  it('does not deadlock when drain is held only by interrupted speech tasks', async () => {
    const { fakeActivity, mainTask, pauseSchedulingTask, speechTasks } = buildMainTaskRunner();

    const interruptedHandle = { interrupted: true } as SpeechHandle;
    const zombieTask = Task.from(
      () => new Promise<void>(() => {}),
      undefined,
      'zombie-speech-task',
    );
    speechTasks.add(zombieTask);
    vi.mocked(_getActivityTaskInfo).mockImplementation((task: Task<unknown>) =>
      task === zombieTask ? ({ speechHandle: interruptedHandle } as never) : undefined,
    );

    const ac = new AbortController();
    const mainTaskPromise = mainTask(ac.signal);
    fakeActivity._mainTask = {
      result: mainTaskPromise,
    };

    // Let mainTask park on q_updated before the drain wakes it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      const result = await raceTimeout(pauseSchedulingTask([]), 2000);
      expect(result).toBe('resolved');
    } finally {
      vi.mocked(_getActivityTaskInfo).mockReturnValue(undefined);
      speechTasks.clear();
      fakeActivity._schedulingPaused = true;
      fakeActivity.q_updated = new Future();
      fakeActivity.q_updated.resolve();
      ac.abort();
      await raceTimeout(mainTaskPromise, 2000);
    }
  });

  it('does not end paused agent speech twice when cancelling it', async () => {
    const handle = SpeechHandle.create({ allowInterruptions: true });
    handle._authorizeGeneration();

    const fakeActivity = {
      cancelSpeechPauseTask: undefined,
      falseInterruptionTimer: undefined,
      falseInterruptionPending: false,
      pausedSpeech: {
        handle,
        agentState: 'speaking',
        timeout: 1000,
      },
      logger: {
        debug: vi.fn(),
      },
      audioRecognition: {
        onEndOfAgentSpeech: vi.fn(async () => {}),
      },
      agentSession: {
        sessionOptions: {
          turnHandling: {
            interruption: {
              resumeFalseInterruption: false,
            },
          },
        },
        output: {
          audio: undefined,
        },
      },
    };

    const cancelSpeechPause = (
      AgentActivity.prototype as unknown as {
        cancelSpeechPause: (options?: { interrupt?: boolean }) => Promise<void>;
      }
    ).cancelSpeechPause.bind(fakeActivity);
    fakeActivity.cancelFalseInterruptionTimer = (
      AgentActivity.prototype as unknown as {
        cancelFalseInterruptionTimer: () => void;
      }
    ).cancelFalseInterruptionTimer.bind(fakeActivity);

    const result = await raceTimeout(cancelSpeechPause(), 2000);

    expect(result).toBe('resolved');
    expect(handle.interrupted).toBe(true);
    expect(fakeActivity.pausedSpeech).toBeUndefined();
    expect(fakeActivity.audioRecognition.onEndOfAgentSpeech).not.toHaveBeenCalled();
  });
});

type FalseInterruptionActivity = {
  pausedSpeech?: {
    handle: SpeechHandle;
    agentState: 'listening' | 'speaking';
    timeout: number;
  };
  activeAgentStateLease?: { activity: unknown; speechHandle: SpeechHandle };
  _currentSpeech?: SpeechHandle;
  falseInterruptionTimer?: NodeJS.Timeout;
  falseInterruptionPending: boolean;
  cancelSpeechPauseTask?: Promise<void>;
  audioRecognition?: {
    endOfTurnTask?: Task<void>;
    isClosed: boolean;
    onStartOfAgentSpeech: ReturnType<typeof vi.fn>;
    onEndOfAgentSpeech: ReturnType<typeof vi.fn>;
  };
  agentSession: {
    _activity?: FalseInterruptionActivity;
    agentState: 'listening' | 'speaking';
    sessionOptions: {
      turnHandling: {
        interruption: { resumeFalseInterruption: boolean; falseInterruptionTimeout: number };
      };
    };
    output: { audio: { canPause: boolean; resume: ReturnType<typeof vi.fn> } };
    _updateAgentState: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
  };
  isInterruptionDetectionEnabled: boolean;
  disableVadInterruptionSoon: ReturnType<typeof vi.fn>;
  logger: { debug: ReturnType<typeof vi.fn> };
  startFalseInterruptionTimer: (timeout: number) => void;
  cancelFalseInterruptionTimer: () => void;
  cancelSpeechPause: (options?: { interrupt?: boolean }) => Promise<void>;
};

function falseInterruptionActivity(endOfTurnTask?: Task<void>): FalseInterruptionActivity {
  const handle = SpeechHandle.create({ allowInterruptions: true });
  const activity = Object.create(AgentActivity.prototype) as FalseInterruptionActivity;
  Object.assign(activity, {
    pausedSpeech: { handle, agentState: 'speaking', timeout: 300 },
    _currentSpeech: handle,
    falseInterruptionTimer: undefined,
    falseInterruptionPending: false,
    cancelSpeechPauseTask: undefined,
    audioRecognition: {
      endOfTurnTask,
      isClosed: false,
      onStartOfAgentSpeech: vi.fn(),
      onEndOfAgentSpeech: vi.fn(async () => {}),
    },
    agentSession: {
      agentState: 'speaking',
      sessionOptions: {
        turnHandling: {
          interruption: { resumeFalseInterruption: true, falseInterruptionTimeout: 300 },
        },
      },
      output: { audio: { canPause: true, resume: vi.fn() } },
      _updateAgentState: vi.fn(),
      emit: vi.fn(),
    },
    isInterruptionDetectionEnabled: false,
    disableVadInterruptionSoon: vi.fn(),
    logger: { debug: vi.fn() },
  });
  activity.agentSession._activity = activity;
  activity.activeAgentStateLease = { activity, speechHandle: handle };
  return activity;
}

function endOfTurnInfo(options: { skipReply?: boolean } = {}): EndOfTurnInfo {
  return {
    newTranscript: '',
    transcriptConfidence: 0,
    transcriptionDelay: undefined,
    endOfUtteranceDelay: undefined,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
    backchannelOverAgent: false,
    skipReply: options.skipReply,
  };
}

class ServerTurnRealtimeModel extends RealtimeModel {
  constructor() {
    const capabilities: RealtimeCapabilities = {
      messageTruncation: false,
      turnDetection: true,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: true,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: false,
      midSessionInstructionsUpdate: false,
      midSessionToolsUpdate: false,
    };
    super(capabilities);
  }

  get model(): string {
    return 'server-turn-test';
  }

  session(): RealtimeSession {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

type EndOfTurnActivity = FalseInterruptionActivity & {
  onEndOfTurn: (info: EndOfTurnInfo) => Promise<boolean>;
  cancelPreemptiveGeneration: ReturnType<typeof vi.fn>;
  createSpeechTask: ReturnType<typeof vi.fn>;
};

/**
 * Builds an activity that can run `onEndOfTurn` on top of a live false-interruption pause, so
 * the "keeps the resume armed" tests can drive the real `cancelFalseInterruptionTimer` and the
 * real timer to expiry instead of asserting on a stub.
 */
function endOfTurnActivity(llm: unknown): EndOfTurnActivity {
  const activity = falseInterruptionActivity() as unknown as EndOfTurnActivity;
  Object.assign(activity.agentSession, {
    amd: undefined,
    llm,
    stt: undefined,
    _textOnly: false,
    turnDetection: 'vad',
  });
  Object.assign(activity.agentSession.sessionOptions.turnHandling.interruption, { minWords: 0 });
  Object.assign(activity, {
    agent: { llm: undefined, stt: undefined, turnHandling: { turnDetection: 'vad' } },
    _schedulingPaused: false,
    newTurnsBlocked: false,
    _userTurnCompletedTask: undefined,
    isInterruptionDetectionEnabled: false,
    cancelPreemptiveGeneration: vi.fn(),
    createSpeechTask: vi.fn(() => ({})),
  });
  return activity;
}

describe('AgentActivity - false interruption resume', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for a dropped turn before resuming', async () => {
    const decision = new Future<void>();
    const task = Task.from(async () => decision.await);
    const activity = falseInterruptionActivity(task);

    activity.startFalseInterruptionTimer(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(activity.falseInterruptionPending).toBe(true);
    expect(activity.agentSession.output.audio.resume).not.toHaveBeenCalled();

    decision.resolve();
    await task.result;
    await vi.waitFor(() =>
      expect(activity.agentSession.output.audio.resume).toHaveBeenCalledOnce(),
    );
  });

  it('suppresses the resume when the turn commits', async () => {
    const decision = new Future<void>();
    const task = Task.from(async () => decision.await);
    const activity = falseInterruptionActivity(task);

    activity.startFalseInterruptionTimer(300);
    await vi.advanceTimersByTimeAsync(300);
    activity.cancelFalseInterruptionTimer();
    decision.resolve();
    await task.result;

    expect(activity.agentSession.output.audio.resume).not.toHaveBeenCalled();
    expect(activity.falseInterruptionPending).toBe(false);
  });

  it('does not resume a deferred pause during teardown', async () => {
    const decision = new Future<void>();
    const task = Task.from(async () => decision.await);
    const activity = falseInterruptionActivity(task);

    activity.startFalseInterruptionTimer(300);
    await vi.advanceTimersByTimeAsync(300);
    activity.audioRecognition!.isClosed = true;
    decision.resolve();
    await task.result;

    expect(activity.agentSession.output.audio.resume).not.toHaveBeenCalled();
  });

  it('does not resume when the turn decision is cancelled', async () => {
    const decision = new Future<void>();
    // Mirrors the real bounce body, which observes the abort and returns normally
    // instead of rejecting (audio_recognition.ts onEndOfTurn task).
    const task = Task.from(async (controller) => {
      await decision.await;
      if (controller.signal.aborted) return;
    });
    const activity = falseInterruptionActivity(task);

    activity.startFalseInterruptionTimer(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(activity.falseInterruptionPending).toBe(true);

    task.cancel();
    decision.resolve();
    await task.result;
    await vi.advanceTimersByTimeAsync(0);

    expect(activity.agentSession.output.audio.resume).not.toHaveBeenCalled();
    // Python's _on_turn_settled returns without touching _paused_speech on a cancelled
    // decision; the teardown that cancelled it owns the release.
    expect(activity.pausedSpeech).toBeDefined();
    expect(activity.falseInterruptionPending).toBe(false);
  });

  it('resumes when the turn decision fails', async () => {
    const decision = new Future<void>();
    const task = Task.from(async () => decision.await);
    const activity = falseInterruptionActivity(task);

    activity.startFalseInterruptionTimer(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(activity.falseInterruptionPending).toBe(true);

    decision.reject(new Error('turn decision failed'));
    await task.result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    // An errored decision is a completed one in Python (add_done_callback fires and
    // cancelled() is False), so the pause must still be released.
    expect(activity.agentSession.output.audio.resume).toHaveBeenCalledOnce();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('keeps the resume armed when the reply is skipped', async () => {
    const activity = endOfTurnActivity(undefined);
    activity.startFalseInterruptionTimer(300);

    expect(await activity.onEndOfTurn(endOfTurnInfo({ skipReply: true }))).toBe(true);

    // The timer must survive the turn and still release the pause, not merely go uncancelled.
    await vi.advanceTimersByTimeAsync(300);
    expect(activity.agentSession.output.audio.resume).toHaveBeenCalledOnce();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('keeps the resume armed when the realtime server owns turn detection', async () => {
    const activity = endOfTurnActivity(new ServerTurnRealtimeModel());
    activity.startFalseInterruptionTimer(300);

    expect(await activity.onEndOfTurn(endOfTurnInfo())).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    expect(activity.agentSession.output.audio.resume).toHaveBeenCalledOnce();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('cancels the resume when a replying turn will interrupt the pause', async () => {
    const activity = endOfTurnActivity(undefined);
    activity.startFalseInterruptionTimer(300);

    expect(await activity.onEndOfTurn(endOfTurnInfo())).toBe(true);

    // Counterpart to the two tests above: proves they are not passing because the fixture
    // can never cancel.
    await vi.advanceTimersByTimeAsync(300);
    expect(activity.agentSession.output.audio.resume).not.toHaveBeenCalled();
  });

  it('does not end agent speech when handing a paused speech to another activity', async () => {
    const activity = falseInterruptionActivity();
    const handle = activity.pausedSpeech!.handle;

    await activity.cancelSpeechPause({ interrupt: false });

    expect(handle.interrupted).toBe(false);
    expect(activity.audioRecognition!.onEndOfAgentSpeech).not.toHaveBeenCalled();
  });

  it('resumes at the timeout when no turn decision is open', async () => {
    const activity = falseInterruptionActivity();

    activity.startFalseInterruptionTimer(300);
    await vi.advanceTimersByTimeAsync(299);
    expect(activity.agentSession.output.audio.resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(activity.agentSession.output.audio.resume).toHaveBeenCalledOnce();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('resumes current playout before it has claimed agent state', async () => {
    const activity = falseInterruptionActivity();
    activity.pausedSpeech!.agentState = 'listening';
    activity.agentSession.agentState = 'listening';
    activity.activeAgentStateLease = undefined;

    activity.startFalseInterruptionTimer(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(activity.agentSession.output.audio.resume).toHaveBeenCalledOnce();
    expect(activity.agentSession._updateAgentState).not.toHaveBeenCalled();
    expect(activity.audioRecognition!.onStartOfAgentSpeech).not.toHaveBeenCalled();
    expect(activity.pausedSpeech).toBeUndefined();
  });

  it('does not resume playout after the activity loses ownership', async () => {
    const activity = falseInterruptionActivity();
    activity.agentSession._activity = undefined;

    activity.startFalseInterruptionTimer(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(activity.agentSession.output.audio.resume).not.toHaveBeenCalled();
    expect(activity.agentSession._updateAgentState).not.toHaveBeenCalled();
    expect(activity.pausedSpeech).toBeUndefined();
  });
});

describe('AgentActivity - speech completion', () => {
  it('ends audio recognition speech when pipeline completion moves session out of speaking', () => {
    const audioRecognition = {
      onEndOfAgentSpeech: vi.fn(async () => {}),
    };
    const speechHandle = {
      done: () => true,
    } as SpeechHandle;
    const fakeActivity = {
      speechQueue: {
        peek: () => undefined,
      },
      _currentSpeech: speechHandle,
      activeAgentStateLease: undefined as unknown,
      audioRecognition,
      agentSession: {
        get _activity() {
          return fakeActivity;
        },
        agentState: 'speaking',
        _updateAgentState: vi.fn((state: string) => {
          fakeActivity.agentSession.agentState = state;
        }),
      },
    };
    const stateLease = { activity: fakeActivity, speechHandle };
    fakeActivity.activeAgentStateLease = stateLease;
    Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);

    const onPipelineReplyDone = (AgentActivity.prototype as Record<string, unknown>)
      .onPipelineReplyDone as (this: typeof fakeActivity, stateLease: typeof stateLease) => void;

    onPipelineReplyDone.call(fakeActivity, stateLease);

    expect(fakeActivity.agentSession._updateAgentState).toHaveBeenCalledWith('listening');
    expect(audioRecognition.onEndOfAgentSpeech).toHaveBeenCalledTimes(1);
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

  const emptyToolCtx = ToolContext.empty();
  const fakeActivity = {
    _preemptiveGenerationCount: 0,
    _preemptiveGeneration: undefined,
    _currentSpeech: undefined as SpeechHandle | undefined,
    schedulingPaused: false,
    llm: new FakePreemptiveLLM(),
    tools: emptyToolCtx,
    toolChoice: null,
    agent: { chatCtx: fakeChatCtx, _toolCtx: emptyToolCtx },
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
});

describe('AgentActivity - onEnter ignored tools', () => {
  const makeFn = (name: string, flags = ToolFlag.NONE) =>
    tool({ name, description: `${name} tool`, flags, execute: async () => name });

  function buildIgnoredToolsActivity() {
    const activity = Object.create(AgentActivity.prototype) as AgentActivity;
    Object.assign(activity, {
      agent: {},
      agentSession: {},
    });
    return activity;
  }

  it('returns bare and toolset-nested IGNORE_ON_ENTER tools only inside this onEnter', () => {
    const endCall = makeFn('end_call', ToolFlag.IGNORE_ON_ENTER);
    const keep = makeFn('keep');
    const bareIgnored = makeFn('bare_ignored', ToolFlag.IGNORE_ON_ENTER);
    const bareKeep = makeFn('bare_keep');
    const toolset = new Toolset({ id: 'ts', tools: [endCall, keep] });
    const toolCtx = new ToolContext([toolset, bareIgnored, bareKeep]);
    const activity = buildIgnoredToolsActivity();

    expect(activity._onEnterIgnoredTools(toolCtx)).toEqual([]);

    onEnterStorage.run({ session: activity.agentSession, agent: activity.agent }, () => {
      expect(
        activity
          ._onEnterIgnoredTools(toolCtx)
          .map((t) => t.id)
          .sort(),
      ).toEqual(['bare_ignored', 'end_call']);
    });

    onEnterStorage.run({ session: activity.agentSession, agent: {} as never }, () => {
      expect(activity._onEnterIgnoredTools(toolCtx)).toEqual([]);
    });
  });

  it('hides ignored bare and toolset tools while preserving normal tools for nested replies', async () => {
    const endCall = makeFn('end_call', ToolFlag.IGNORE_ON_ENTER);
    const keep = makeFn('keep');
    const bareIgnored = makeFn('bare_ignored', ToolFlag.IGNORE_ON_ENTER);
    const toolset = new Toolset({ id: 'ts', tools: [endCall, keep] });
    const activity = buildIgnoredToolsActivity();

    await onEnterStorage.run(
      { session: activity.agentSession, agent: activity.agent },
      async () => {
        const greetingTools = new ToolContext([toolset, bareIgnored]);
        greetingTools._exclude(activity._onEnterIgnoredTools(greetingTools));
        expect(greetingTools.flatten().map((t) => t.id)).toEqual(['keep']);
        expect(greetingTools.toolsets).toEqual([toolset]);

        await Promise.resolve();

        const toolReplyTools = new ToolContext([toolset, bareIgnored]);
        toolReplyTools._exclude(activity._onEnterIgnoredTools(toolReplyTools));
        expect(toolReplyTools.flatten().map((t) => t.id)).toEqual(['keep']);
      },
    );

    const restoredTools = new ToolContext([toolset, bareIgnored]);
    expect(
      restoredTools
        .flatten()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['bare_ignored', 'end_call', 'keep']);
  });
});

/**
 * Regression test for the dynamic-toolset push path.
 *
 * When an already-activated toolset swaps its tools at runtime (e.g. an MCP server pushes a new
 * tool list via `ToolsetContext.updateTools`), `setupToolsetList`'s wiring must (1) invoke
 * `onToolsetToolsChanged`, which now funnels through `updateTools`, and (2) record an
 * `AgentConfigUpdate` in the agent chat context + session history so a non-realtime pipeline's
 * chat context reflects the new tool set on the next turn.
 */
class FakeToolsetLLM extends LLM {
  label(): string {
    return 'fake.toolset.LLM';
  }
  chat(): LLMStream {
    throw new Error('not used in these tests');
  }
}

describe('AgentActivity - onToolsetToolsChanged (dynamic toolset push)', () => {
  const makeFn = (name: string) =>
    tool({ name, description: `${name} tool`, execute: async () => name });

  function buildToolsetActivity(toolset: Toolset) {
    const history = new ChatContext();
    const fakeActivity = {
      _toolsetsSetup: true,
      realtimeSession: undefined,
      llm: new FakeToolsetLLM(),
      agent: {
        _toolCtx: new ToolContext([toolset]),
        _chatCtx: new ChatContext(),
      },
      agentSession: { history },
      updateChatCtx: vi.fn(async () => {}),
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    };
    Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);
    return { fakeActivity, history };
  }

  it('fires onToolsetToolsChanged on a dynamic push and records an AgentConfigUpdate', async () => {
    const toolA = makeFn('toolA');
    const toolB = makeFn('toolB');

    // Capture the wired ctx.updateTools the framework hands the toolset during setup.
    let pushTools!: (tools: readonly Tool[]) => void;
    const toolset = Toolset.create({
      id: 'dynamic',
      tools: [toolA],
      setup: async ({ updateTools }) => {
        pushTools = updateTools;
      },
    });

    const { fakeActivity, history } = buildToolsetActivity(toolset);

    const changedSpy = vi.spyOn(
      AgentActivity.prototype as unknown as Record<'onToolsetToolsChanged', () => Promise<void>>,
      'onToolsetToolsChanged',
    );

    // Activate the toolset through the real path so it captures the push channel.
    const setupToolsetList = (AgentActivity.prototype as Record<string, unknown>)
      .setupToolsetList as (this: unknown, toolsets: readonly Toolset[]) => Promise<void>;
    await setupToolsetList.call(fakeActivity, [toolset]);

    expect(changedSpy).not.toHaveBeenCalled();

    // (1) A dynamic push swaps the toolset's tools — the wiring must invoke onToolsetToolsChanged.
    pushTools([toolA, toolB]);
    expect(changedSpy).toHaveBeenCalledTimes(1);
    await changedSpy.mock.results[0]!.value;

    // (2) An AgentConfigUpdate naming the added tool lands in the session history.
    const updates = history.items.filter(
      (i): i is AgentConfigUpdate => i instanceof AgentConfigUpdate,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.toolsAdded).toContain('toolB');
    expect(updates[0]!.toolsRemoved ?? []).not.toContain('toolA');

    // The refreshed tool context advertises the new tool to the next turn, and the non-realtime
    // pipeline's chat context was refreshed via updateChatCtx.
    expect(Object.keys(fakeActivity.agent._toolCtx.functionTools).sort()).toEqual([
      'toolA',
      'toolB',
    ]);
    expect(fakeActivity.updateChatCtx).toHaveBeenCalledTimes(1);

    changedSpy.mockRestore();
  });
});

/**
 * Regression test for PR #1736 review (#3378550188): session-level toolsets must have `setup()`
 * run ONCE for the session's lifetime (their `aclose()` runs once at session close), while
 * agent-level toolsets are set up per activity. Re-running a session toolset's `setup()` on every
 * handoff would acquire resources without a matching `aclose()` (resource/listener leak).
 */
describe('AgentActivity - session toolset setup lifecycle (#3378550188)', () => {
  function buildSetupActivity(
    agentSession: {
      tools: Toolset[];
      toolCtx: ToolContext;
      _sessionToolsetsSetup: boolean;
    },
    agentToolset: Toolset,
  ) {
    const fakeActivity = {
      _toolsetsSetup: false,
      agentSession,
      agent: {
        toolCtx: new ToolContext([agentToolset]),
        _toolCtx: { tools: [] as Tool[], updateTools: vi.fn() },
      },
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    };
    Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);
    return fakeActivity;
  }

  it('sets up session toolsets once across a handoff; agent toolsets per activity', async () => {
    const sessionSetup = vi.fn(async () => {});
    const sessionToolset = Toolset.create({ id: 'session', tools: [], setup: sessionSetup });

    const agentSetupA = vi.fn(async () => {});
    const agentToolsetA = Toolset.create({ id: 'agent_a', tools: [], setup: agentSetupA });
    const agentSetupB = vi.fn(async () => {});
    const agentToolsetB = Toolset.create({ id: 'agent_b', tools: [], setup: agentSetupB });

    const agentSession = {
      tools: [sessionToolset],
      toolCtx: new ToolContext([sessionToolset]),
      _sessionToolsetsSetup: false,
    };

    const setupToolsets = (AgentActivity.prototype as Record<string, unknown>).setupToolsets as (
      this: unknown,
    ) => Promise<void>;

    // Activity #1 (agent A) sets up its own toolset + the session toolset.
    await setupToolsets.call(buildSetupActivity(agentSession, agentToolsetA));
    // Activity #2 (handoff to agent B): a fresh activity with its own _toolsetsSetup=false.
    await setupToolsets.call(buildSetupActivity(agentSession, agentToolsetB));

    expect(sessionSetup).toHaveBeenCalledTimes(1);
    expect(agentSetupA).toHaveBeenCalledTimes(1);
    expect(agentSetupB).toHaveBeenCalledTimes(1);
    expect(agentSession._sessionToolsetsSetup).toBe(true);
  });
});

describe('AgentActivity - preemptive generation tool snapshot (#3407098507)', () => {
  it('snapshots the merged tool set so reuse is not invalidated when a cancellable tool is present', () => {
    const cancellable = tool({
      name: 'bookFlight',
      description: 'book a flight',
      execute: async () => 'ok',
      flags: ToolFlag.CANCELLABLE,
    });
    const agentToolCtx = new ToolContext([cancellable]);

    const generateReply = vi.fn(
      () => ({ id: 'speech_fake', _cancel: () => {} }) as unknown as SpeechHandle,
    );

    const fakeActivity = {
      _preemptiveGenerationCount: 0,
      _preemptiveGeneration: undefined as unknown,
      _currentSpeech: undefined as SpeechHandle | undefined,
      schedulingPaused: false,
      newTurnsBlocked: false,
      llm: new FakePreemptiveLLM(),
      toolChoice: null,
      // `get tools()` (real prototype getter) reads agentSession.toolCtx + agent.toolCtx and
      // injects the management tools when a cancellable tool exists. We intentionally do NOT set
      // an own `tools` property so the real getter runs.
      agent: { chatCtx: new ChatContext(), toolCtx: agentToolCtx, _toolCtx: agentToolCtx },
      agentSession: {
        toolCtx: ToolContext.empty(),
        sessionOptions: {
          turnHandling: {
            preemptiveGeneration: {
              enabled: true,
              preemptiveTts: false,
              maxSpeechDuration: 10_000,
              maxRetries: 3,
            },
          },
        },
      },
      logger: { info() {}, debug() {}, warn() {}, error() {} },
      generateReply,
      cancelPreemptiveGeneration: vi.fn(),
    };
    Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);

    const onPreemptiveGeneration = (AgentActivity.prototype as unknown as Record<string, unknown>)
      .onPreemptiveGeneration as (this: unknown, info: PreemptiveGenerationInfo) => void;

    onPreemptiveGeneration.call(fakeActivity, {
      newTranscript: 'hello world',
      transcriptConfidence: 0.95,
      startedSpeakingAt: undefined,
    });

    const snapshot = fakeActivity._preemptiveGeneration as { tools: ToolContext } | undefined;
    expect(snapshot).toBeDefined();

    const liveTools = (fakeActivity as unknown as { tools: ToolContext }).tools;
    // Sanity: the live merged set is larger than agent-only (it injected the management tools),
    // which is exactly the condition under which the old agent-only snapshot diverged.
    expect(liveTools.tools.length).toBeGreaterThan(agentToolCtx.tools.length);

    // The reuse check (onUserTurnCompleted) does `preemptive.tools.equals(this.tools)`.
    expect(snapshot!.tools.equals(liveTools)).toBe(true);
  });
});

describe('AgentActivity - waitForIdle close abort', () => {
  it('returns promptly when the activity closes while waiting', async () => {
    const closeAbort = new AbortController();
    const fakeActivity = {
      closeAbort,
      // Simulates a wait that only completes when its signal aborts (the spin condition).
      waitForInactive: (_options: unknown, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      agentSession: { _waitForIdleHoldReleased: async () => false },
    };
    Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);

    const waitForIdle = (
      AgentActivity.prototype as unknown as { waitForIdle: (this: unknown) => Promise<void> }
    ).waitForIdle.bind(fakeActivity);

    const pending = waitForIdle();
    // Not idle yet — the wait is still pending.
    expect(await raceTimeout(pending, 50)).toBe('timeout');

    // close() aborts the shared signal; the wait must unblock.
    closeAbort.abort();
    expect(await raceTimeout(pending, 1000)).toBe('resolved');
  });
});

describe('AgentActivity - interrupted tool completion', () => {
  it('preserves completed outputs without starting a tool-reply generation', () => {
    const generateReply = vi.fn();
    const toolItemsAdded = vi.fn();
    const activity = Object.create(AgentActivity.prototype) as AgentActivity;
    const chatCtx = ChatContext.empty();
    Object.assign(activity, {
      agent: { _chatCtx: chatCtx },
      agentSession: {
        emit: vi.fn(),
        _toolItemsAdded: toolItemsAdded,
        generateReply,
      },
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    const call = FunctionCall.create({
      callId: 'call_completed',
      name: 'charge_card',
      args: '{}',
    });
    const output = FunctionCallOutput.create({
      callId: call.callId,
      name: call.name,
      output: 'charged',
      isError: false,
    });
    call.createdAt = 200;
    output.createdAt = 300;
    chatCtx.insert(call);
    const toolOutput = {
      output: [
        ToolExecutionOutput.create({
          toolCall: call,
          toolCallOutput: output,
          rawOutput: 'charged',
          replyRequired: true,
        }),
      ],
      firstToolStartedFuture: new Future<void>(),
    };

    (
      activity as unknown as {
        _commitInterruptedToolOutputs: (
          toolOutput: typeof toolOutput,
          speechHandle: SpeechHandle,
        ) => void;
      }
    )._commitInterruptedToolOutputs(toolOutput, SpeechHandle.create());

    expect(chatCtx.items).toContain(output);
    expect(output.createdAt).toBe(300);
    expect(chatCtx.items).toEqual([call, output]);
    expect(toolItemsAdded).toHaveBeenCalledWith([output]);
    expect(generateReply).not.toHaveBeenCalled();
  });

  it('does not persist an interrupted handoff as completed', () => {
    const emit = vi.fn();
    const toolItemsAdded = vi.fn();
    const activity = Object.create(AgentActivity.prototype) as AgentActivity;
    const chatCtx = ChatContext.empty();
    const sessionHistory = ChatContext.empty();
    Object.assign(activity, {
      agent: { _chatCtx: chatCtx },
      agentSession: {
        emit,
        history: sessionHistory,
        _toolItemsAdded: toolItemsAdded,
      },
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    const call = FunctionCall.create({
      callId: 'call_handoff',
      name: 'transfer_to_specialist',
      args: '{}',
    });
    const output = FunctionCallOutput.create({
      callId: call.callId,
      name: call.name,
      output: 'transferred',
      isError: false,
    });
    chatCtx.insert(call);
    sessionHistory.insert(call);
    const toolOutput = {
      output: [
        ToolExecutionOutput.create({
          toolCall: call,
          toolCallOutput: output,
          rawOutput: 'transferred',
          replyRequired: false,
          agentTask: new AgentTask({ instructions: 'Handle the specialist request.' }),
        }),
      ],
      firstToolStartedFuture: new Future<void>(),
    };

    (
      activity as unknown as {
        _commitInterruptedToolOutputs: (
          toolOutput: typeof toolOutput,
          speechHandle: SpeechHandle,
        ) => void;
      }
    )._commitInterruptedToolOutputs(toolOutput, SpeechHandle.create());

    expect(chatCtx.items).not.toContain(call);
    expect(chatCtx.items).not.toContain(output);
    expect(sessionHistory.items).not.toContain(call);
    expect(emit).not.toHaveBeenCalled();
    expect(toolItemsAdded).not.toHaveBeenCalled();
  });

  it('commits and emits only completed regular tools from a mixed interrupted batch', () => {
    const emit = vi.fn();
    const toolItemsAdded = vi.fn();
    const activity = Object.create(AgentActivity.prototype) as AgentActivity;
    const chatCtx = ChatContext.empty();
    const sessionHistory = ChatContext.empty();
    Object.assign(activity, {
      agent: { _chatCtx: chatCtx },
      agentSession: { emit, history: sessionHistory, _toolItemsAdded: toolItemsAdded },
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    const completedCall = FunctionCall.create({
      callId: 'call_completed_mixed',
      name: 'save_note',
      args: '{}',
    });
    const completedOutput = FunctionCallOutput.create({
      callId: completedCall.callId,
      name: completedCall.name,
      output: 'saved',
      isError: false,
    });
    const handoffCall = FunctionCall.create({
      callId: 'call_handoff_mixed',
      name: 'transfer_to_specialist',
      args: '{}',
    });
    const handoffOutput = FunctionCallOutput.create({
      callId: handoffCall.callId,
      name: handoffCall.name,
      output: 'transferred',
      isError: false,
    });
    chatCtx.insert([completedCall, handoffCall]);
    sessionHistory.insert([completedCall, handoffCall]);
    const toolOutput = {
      output: [
        ToolExecutionOutput.create({
          toolCall: completedCall,
          toolCallOutput: completedOutput,
          rawOutput: 'saved',
          replyRequired: true,
        }),
        ToolExecutionOutput.create({
          toolCall: handoffCall,
          toolCallOutput: handoffOutput,
          rawOutput: 'transferred',
          replyRequired: false,
          agentTask: new AgentTask({ instructions: 'Handle the specialist request.' }),
        }),
      ],
      firstToolStartedFuture: new Future<void>(),
    };

    (
      activity as unknown as {
        _commitInterruptedToolOutputs: (
          toolOutput: typeof toolOutput,
          speechHandle: SpeechHandle,
        ) => void;
      }
    )._commitInterruptedToolOutputs(toolOutput, SpeechHandle.create());

    expect(chatCtx.items).toHaveLength(2);
    expect(chatCtx.items).toEqual(expect.arrayContaining([completedCall, completedOutput]));
    expect(sessionHistory.items).toEqual([completedCall]);
    expect(toolItemsAdded).toHaveBeenCalledWith([completedOutput]);
    expect(emit).toHaveBeenCalledWith(
      AgentSessionEventTypes.FunctionToolsExecuted,
      expect.objectContaining({
        functionCalls: [completedCall],
        functionCallOutputs: [completedOutput],
      }),
    );
  });
});

describe('AgentActivity - realtime reply chat context push', () => {
  function buildRealtimeReplyActivity(updateError?: unknown) {
    const userSilenceEvent = new Event();
    userSilenceEvent.set();
    const generationEvent = {} as GenerationCreatedEvent;
    const realtimeSession = {
      chatCtx: ChatContext.empty(),
      tools: ToolContext.empty(),
      updateChatCtx: vi.fn(async (chatCtx: ChatContext) => {
        if (updateError) {
          throw updateError;
        }
        realtimeSession.chatCtx = chatCtx.copy();
      }),
      updateTools: vi.fn(async () => {}),
      updateOptions: vi.fn(),
      generateReply: vi.fn(async () => generationEvent),
    };
    const activity = {
      realtimeSession,
      toolChoice: undefined,
      _onEnterIgnoredTools: () => [],
      agent: { _chatCtx: ChatContext.empty() },
      agentSession: {
        _conversationItemAdded: vi.fn(),
      },
      userSilenceEvent,
      realtimeGenerationTask: vi.fn(async () => {}),
      logger: { info() {}, debug() {}, warn: vi.fn(), error: vi.fn() },
    };
    Object.setPrototypeOf(activity, AgentActivity.prototype);

    return { activity, realtimeSession };
  }

  async function runRealtimeReplyTask(activity: unknown, speechHandle: SpeechHandle) {
    const stateLease = { activity, speechHandle };
    const realtimeReplyTask = (
      AgentActivity.prototype as unknown as {
        realtimeReplyTask(
          this: unknown,
          args: {
            stateLease: typeof stateLease;
            modelSettings: { toolChoice?: never };
            abortController: AbortController;
            userInput: string;
          },
        ): Promise<void>;
      }
    ).realtimeReplyTask;

    await realtimeReplyTask.call(activity, {
      stateLease,
      modelSettings: {},
      abortController: new AbortController(),
      userInput: 'hello',
    });
  }

  it('generates a reply when updateChatCtx succeeds', async () => {
    const { activity, realtimeSession } = buildRealtimeReplyActivity();
    const handle = SpeechHandle.create();
    handle._authorizeGeneration();

    await runRealtimeReplyTask(activity, handle);

    expect(realtimeSession.generateReply).toHaveBeenCalledTimes(1);
    expect(activity.realtimeGenerationTask).toHaveBeenCalledTimes(1);
    expect(handle.done()).toBe(false);
  });

  it('still generates a reply when updateChatCtx raises RealtimeError', async () => {
    const { activity, realtimeSession } = buildRealtimeReplyActivity(
      new RealtimeError('update_chat_ctx timed out.'),
    );
    const handle = SpeechHandle.create();
    handle._authorizeGeneration();

    await runRealtimeReplyTask(activity, handle);

    expect(realtimeSession.generateReply).toHaveBeenCalledTimes(1);
    expect(activity.realtimeGenerationTask).toHaveBeenCalledTimes(1);
    expect(handle.done()).toBe(false);
    expect(activity.agent._chatCtx.items.some((item) => item.type === 'message')).toBe(true);
  });

  it('marks the speech handle failed for unexpected updateChatCtx errors', async () => {
    const error = new Error('boom');
    const { activity, realtimeSession } = buildRealtimeReplyActivity(error);
    const handle = SpeechHandle.create();
    handle._authorizeGeneration();

    await runRealtimeReplyTask(activity, handle);

    expect(realtimeSession.generateReply).not.toHaveBeenCalled();
    expect(activity.realtimeGenerationTask).not.toHaveBeenCalled();
    expect(handle.done()).toBe(true);
    expect(handle.exception()).toBe(error);
  });
});

describe('AgentActivity - interruption while waiting for tools', () => {
  function buildToolOutput() {
    const call = FunctionCall.create({
      callId: 'call_waiting',
      name: 'save_note',
      args: '{}',
    });
    const output = FunctionCallOutput.create({
      callId: call.callId,
      name: call.name,
      output: 'saved',
      isError: false,
    });
    return {
      output: [
        ToolExecutionOutput.create({
          toolCall: call,
          toolCallOutput: output,
          rawOutput: 'saved',
          replyRequired: true,
        }),
      ],
      firstToolStartedFuture: new Future<void>(),
    };
  }

  type WaitForToolExecution = (options: {
    executeToolsTask: {
      result: Promise<void>;
      cancelAndWait: (timeout: number) => Promise<void>;
    };
    toolOutput: ReturnType<typeof buildToolOutput>;
    speechHandle: SpeechHandle;
  }) => Promise<boolean>;

  function buildActivity() {
    const commitInterruptedToolOutputs = vi.fn();
    const activity = Object.create(AgentActivity.prototype) as AgentActivity;
    Object.assign(activity, {
      _backgroundSpeeches: new Set<SpeechHandle>(),
      _commitInterruptedToolOutputs: commitInterruptedToolOutputs,
      logger: log(),
    });
    const waitForToolExecution = (
      activity as unknown as { _waitForToolExecution: WaitForToolExecution }
    )._waitForToolExecution.bind(activity);
    return { activity, commitInterruptedToolOutputs, waitForToolExecution };
  }

  it('commits completed outputs when already interrupted before waiting', async () => {
    const { activity, commitInterruptedToolOutputs, waitForToolExecution } = buildActivity();
    const speechHandle = SpeechHandle.create();
    speechHandle.interrupt();
    const cancelAndWait = vi.fn(async () => {});
    const toolOutput = buildToolOutput();

    const shouldContinue = await waitForToolExecution({
      executeToolsTask: { result: Promise.resolve(), cancelAndWait },
      toolOutput,
      speechHandle,
    });

    expect(shouldContinue).toBe(false);
    expect(cancelAndWait).toHaveBeenCalledOnce();
    expect(commitInterruptedToolOutputs).toHaveBeenCalledWith(toolOutput, speechHandle);
    expect(activity['_backgroundSpeeches']).not.toContain(speechHandle);
  });

  it('rechecks interruption after tool execution settles', async () => {
    const { activity, commitInterruptedToolOutputs, waitForToolExecution } = buildActivity();
    const speechHandle = SpeechHandle.create();
    const executionFinished = new Future<void>();
    const toolOutput = buildToolOutput();

    const waiting = waitForToolExecution({
      executeToolsTask: {
        result: executionFinished.await,
        cancelAndWait: vi.fn(async () => {}),
      },
      toolOutput,
      speechHandle,
    });
    expect(activity['_backgroundSpeeches']).toContain(speechHandle);

    speechHandle.interrupt();
    executionFinished.resolve();

    await expect(waiting).resolves.toBe(false);
    expect(commitInterruptedToolOutputs).toHaveBeenCalledWith(toolOutput, speechHandle);
    expect(activity['_backgroundSpeeches']).not.toContain(speechHandle);
  });

  it('still commits outputs when cancelling the tool task overruns its budget', async () => {
    // `Task.cancelAndWait` throws once the cooperative-cancel budget expires. A tool that
    // ignores its abort signal must not take the commit down with it — the LLM has already
    // seen these outputs, so dropping them leaves the function calls dangling.
    const { commitInterruptedToolOutputs, waitForToolExecution } = buildActivity();
    const speechHandle = SpeechHandle.create();
    speechHandle.interrupt();
    const toolOutput = buildToolOutput();

    const shouldContinue = await waitForToolExecution({
      executeToolsTask: {
        result: new Promise<void>(() => {}),
        cancelAndWait: vi.fn(async () => {
          throw new Error('Task cancellation timed out');
        }),
      },
      toolOutput,
      speechHandle,
    });

    expect(shouldContinue).toBe(false);
    expect(commitInterruptedToolOutputs).toHaveBeenCalledWith(toolOutput, speechHandle);
  });
});

/**
 * A realtime provider only publishes the final user transcript once the reply has
 * finished generating, so committing the message at that moment stamps the user turn
 * later than the reply it prompted and the transcript renders them out of order. The
 * provider reports when the turn began via `turnStartedAt`.
 */
describe('AgentActivity - realtime user turn timing', () => {
  function buildRealtimeActivity() {
    const chatCtx = new ChatContext();
    const fakeActivity = {
      vad: undefined,
      stt: undefined,
      audioRecognition: undefined,
      isInterruptionDetectionEnabled: false,
      agent: { _chatCtx: chatCtx },
      agentSession: {
        emit: vi.fn(),
        _updateUserState: vi.fn(),
        _conversationItemAdded: vi.fn(),
      },
      interrupt: vi.fn(),
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    };
    Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);

    const proto = AgentActivity.prototype as unknown as Record<string, (...args: never[]) => void>;
    return {
      chatCtx,
      transcribed: (transcript: string, itemId: string, turnStartedAt?: number) =>
        proto.onInputAudioTranscriptionCompleted!.call(fakeActivity, {
          transcript,
          itemId,
          isFinal: true,
          turnStartedAt,
        } as never),
    };
  }

  it('stamps the user message where the turn began, not at transcript delivery', () => {
    vi.useFakeTimers();
    try {
      // the provider withholds the transcript until its reply is done generating
      vi.setSystemTime(1_007_000);
      const { chatCtx, transcribed } = buildRealtimeActivity();

      transcribed('what is my name?', 'item_1', 1_000_000);

      const message = chatCtx.items[0]!;
      if (message.type !== 'message') throw new Error('expected a chat message');
      expect(message.createdAt).toBe(1_000_000);
      // seconds, so the dashboard can place the turn where it happened
      expect(message.metrics?.startedSpeakingAt).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('places the turn before the reply it prompted when its transcript lands later', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_007_000);
      const { chatCtx, transcribed } = buildRealtimeActivity();

      // the reply is committed first, because the provider held the user transcript back
      chatCtx.insert(
        ChatMessage.create({ role: 'assistant', content: 'you are Brian', createdAt: 1_003_000 }),
      );
      transcribed('what is my name?', 'item_1', 1_000_000);

      expect(
        chatCtx.items.map((item) => (item.type === 'message' ? item.role : item.type)),
      ).toEqual(['user', 'assistant']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pairs each turn with its own start, even when transcripts arrive late', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_010_000);
      const { chatCtx, transcribed } = buildRealtimeActivity();

      // both transcripts land after the second turn began; each keeps its own start
      transcribed('first', 'item_1', 1_000_000);
      transcribed('second', 'item_2', 1_005_000);

      const [first, second] = chatCtx.items;
      if (first?.type !== 'message' || second?.type !== 'message') {
        throw new Error('expected chat messages');
      }
      expect(first.createdAt).toBe(1_000_000);
      expect(second.createdAt).toBe(1_005_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to delivery time when the provider reports no turn start', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_002_000);
      const { chatCtx, transcribed } = buildRealtimeActivity();

      transcribed('text injected turn', 'item_1');

      const message = chatCtx.items[0]!;
      if (message.type !== 'message') throw new Error('expected a chat message');
      expect(message.createdAt).toBe(1_002_000);
      expect(message.metrics?.startedSpeakingAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentActivity - transcriptsEquivalent', () => {
  it.each([
    // Formatting-only differences must not invalidate the preemptive generation
    // (Python: test_formatting_only_final_reuses_preemptive_generation).
    {
      name: 'casing, spacing and trailing punctuation',
      first: 'BOOK   A ROOM',
      second: 'book a room.',
      expected: true,
    },
    // A changed word must invalidate it (Python: test_changed_words_invalidate_preemptive_generation).
    { name: 'a changed word', first: 'book a', second: 'book a room', expected: false },
    // Guard clause: there is no finalized transcript to compare against.
    {
      name: 'an undefined finalized transcript',
      first: 'book a room',
      second: undefined,
      expected: false,
    },
    // Both sides tokenize to nothing, so there is nothing to call equivalent.
    { name: 'transcripts that tokenize to no words', first: '...', second: '', expected: false },
    // The CJK/Thai alternation splits those scripts per character, so whitespace between
    // them is irrelevant — this is what emulates Python's `split_character=True`.
    {
      name: 'CJK characters split by whitespace',
      first: '你好world',
      second: '你 好 world',
      expected: true,
    },
    {
      name: 'Thai characters split by whitespace',
      first: 'สวัสดี ครับ',
      second: 'สวัสดีครับ',
      expected: true,
    },
    // Documented divergence: Python's `casefold()` maps ß -> ss and returns true here, while
    // JS `toLowerCase()` does not. Erring conservative (regenerate rather than reuse) is the
    // safe direction: extra work, never a generation reused for a different utterance.
    {
      name: 'a fold JS toLowerCase() does not perform (Python casefold() returns true)',
      first: 'STRASSE',
      second: 'straße',
      expected: false,
    },
  ])('returns $expected for $name', ({ first, second, expected }) => {
    expect(transcriptsEquivalent(first, second)).toBe(expected);
  });
});

/**
 * The pipeline task retains the speculative ChatMessage built at preflight time, so when the
 * preemptive generation is reused that message — not the finalized one — is what lands in
 * conversation history. It must therefore be reconciled with the finalized transcript and any
 * onUserTurnCompleted edits before the speech is scheduled (agent_activity.ts:2510-2517).
 */
describe('AgentActivity - preemptive generation reconciliation', () => {
  function buildReuseActivity(
    onUserTurnCompleted: (chatCtx: ChatContext, message: ChatMessage) => void,
  ) {
    const emptyToolCtx = ToolContext.empty();
    const speculativeMessage = ChatMessage.create({
      role: 'user',
      content: 'BOOK   A ROOM',
      transcriptConfidence: 0.4,
    });
    const speechHandle = SpeechHandle.create();
    const scheduleSpeech = vi.fn();
    const generateReply = vi.fn();
    const speechQueue = new Heap<[number, number, SpeechHandle]>(
      (a, b) => b[0] - a[0] || a[1] - b[1],
    );

    const fakeActivity = {
      _preemptiveGenerationCount: 1,
      _currentSpeech: undefined as SpeechHandle | undefined,
      schedulingPaused: false,
      newTurnsBlocked: false,
      llm: new FakePreemptiveLLM(),
      tools: emptyToolCtx,
      toolChoice: null,
      agent: {
        chatCtx: new ChatContext(),
        onUserTurnCompleted: async (chatCtx: ChatContext, message: ChatMessage) => {
          onUserTurnCompleted(chatCtx, message);
        },
      },
      agentSession: { emit: vi.fn() },
      logger: { info() {}, debug() {}, warn() {}, error() {} },
      _preemptiveGeneration: {
        speechHandle,
        userMessage: speculativeMessage,
        info: { newTranscript: 'BOOK   A ROOM', transcriptConfidence: 0.4 },
        chatCtx: new ChatContext(),
        tools: emptyToolCtx,
        toolChoice: null,
        createdAt: Date.now(),
      },
      scheduleSpeech,
      generateReply,
      speechQueue,
    };
    Object.setPrototypeOf(fakeActivity, AgentActivity.prototype);

    const userTurnCompleted = (AgentActivity.prototype as unknown as Record<string, unknown>)
      .userTurnCompleted as (this: unknown, info: unknown) => Promise<void>;

    return {
      fakeActivity,
      speculativeMessage,
      speechHandle,
      scheduleSpeech,
      generateReply,
      // A formatting-only finalized transcript, so the reuse guard passes.
      completeTurn: () =>
        userTurnCompleted.call(fakeActivity, {
          newTranscript: 'book a room.',
          transcriptConfidence: 0.9,
          skipReply: false,
        }),
    };
  }

  it('reconciles the retained speculative message with the finalized transcript', async () => {
    const harness = buildReuseActivity(() => {});

    await harness.completeTurn();

    // Reused, not regenerated.
    expect(harness.scheduleSpeech).toHaveBeenCalledWith(harness.speechHandle, expect.any(Number));
    expect(harness.generateReply).not.toHaveBeenCalled();
    expect(harness.fakeActivity._preemptiveGeneration).toBeUndefined();

    // The message committed to history is the speculative one, carrying the finalized values.
    expect(harness.speculativeMessage.content).toEqual(['book a room.']);
    expect(harness.speculativeMessage.transcriptConfidence).toBe(0.9);
  });

  it('keeps onUserTurnCompleted edits on the retained speculative message', async () => {
    const harness = buildReuseActivity((_chatCtx, message) => {
      message.content = ['book a room!'];
      message.transcriptConfidence = 0.42;
    });

    await harness.completeTurn();

    expect(harness.scheduleSpeech).toHaveBeenCalledWith(harness.speechHandle, expect.any(Number));
    expect(harness.generateReply).not.toHaveBeenCalled();
    expect(harness.speculativeMessage.content).toEqual(['book a room!']);
    expect(harness.speculativeMessage.transcriptConfidence).toBe(0.42);
  });
});
