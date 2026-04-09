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
import { LLM } from '../llm/llm.js';
import { Future } from '../utils.js';
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
    getDrainPendingSpeechTasks: () => [],
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  const mainTask = (AgentActivity.prototype as unknown as Record<string, unknown>).mainTask as (
    signal: AbortSignal,
  ) => Promise<void>;

  return {
    fakeActivity,
    mainTask: mainTask.bind(fakeActivity),
    speechQueue,
    q_updated,
  };
}

describe('AgentActivity - _toolExecutionInProgress guard', () => {
  it('should block preemptive generation when tool execution is in progress', () => {
    // onPreemptiveGeneration checks this._toolExecutionInProgress and early-returns.
    // We verify the guard by calling the method on a minimal stub where all other
    // guards pass but _toolExecutionInProgress is true.
    const onPreemptiveGeneration = (AgentActivity.prototype as unknown as Record<string, unknown>)
      .onPreemptiveGeneration as (info: PreemptiveGenerationInfo) => void;

    const generateReplySpy = vi.fn();
    const fakeActivity = {
      agentSession: { sessionOptions: { preemptiveGeneration: true } },
      schedulingPaused: false,
      _currentSpeech: undefined,
      _toolExecutionInProgress: true,
      llm: Object.create(LLM.prototype),
      _preemptiveGeneration: undefined,
      cancelPreemptiveGeneration: vi.fn(),
      generateReply: generateReplySpy,
      agent: { chatCtx: { copy: () => ({ copy: () => ({}) }) } },
      tools: {},
      toolChoice: null,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    onPreemptiveGeneration.call(fakeActivity, {
      newTranscript: 'test transcript',
      transcriptConfidence: 1.0,
    } as PreemptiveGenerationInfo);

    expect(generateReplySpy).not.toHaveBeenCalled();
    expect(fakeActivity._preemptiveGeneration).toBeUndefined();
  });

  it('should allow preemptive generation when no tool execution is in progress', () => {
    const onPreemptiveGeneration = (AgentActivity.prototype as unknown as Record<string, unknown>)
      .onPreemptiveGeneration as (info: PreemptiveGenerationInfo) => void;

    const mockSpeechHandle = { id: 'test' };
    const generateReplySpy = vi.fn().mockReturnValue(mockSpeechHandle);
    const fakeActivity = {
      agentSession: { sessionOptions: { preemptiveGeneration: true } },
      schedulingPaused: false,
      _currentSpeech: undefined,
      _toolExecutionInProgress: false,
      llm: Object.create(LLM.prototype),
      _preemptiveGeneration: undefined,
      cancelPreemptiveGeneration: vi.fn(),
      generateReply: generateReplySpy,
      agent: { chatCtx: { copy: () => ({ copy: () => ({}) }) } },
      tools: {},
      toolChoice: null,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    onPreemptiveGeneration.call(fakeActivity, {
      newTranscript: 'test transcript',
      transcriptConfidence: 1.0,
    } as PreemptiveGenerationInfo);

    expect(generateReplySpy).toHaveBeenCalledOnce();
    expect(fakeActivity._preemptiveGeneration).toBeDefined();
  });
});

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
});
