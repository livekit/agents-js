// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * AgentActivity.interrupt() and queued speeches that disallow interruptions.
 *
 * SpeechHandle.interrupt() throws for such a handle, and the queue loop used to let that error
 * escape. Interrupting past the protected speech would be wrong too: the ones behind it still
 * play, so skipping one in the middle would leave a gap in the conversation.
 */
import { Heap } from 'heap-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { Future } from '../utils.js';
import { AgentActivity } from './agent_activity.js';
import { SpeechHandle } from './speech_handle.js';

type HeapItem = [number, number, SpeechHandle];

const handles: SpeechHandle[] = [];
let sequence = 0;

function makeSpeech(allowInterruptions: boolean): SpeechHandle {
  const speech = SpeechHandle.create({ allowInterruptions });
  handles.push(speech);
  return speech;
}

function makeActivity() {
  const speechQueue = new Heap<HeapItem>((a, b) => b[0] - a[0] || a[1] - b[1]);
  const realtimeInterrupt = vi.fn();
  const warn = vi.fn();
  const activity = Object.create(AgentActivity.prototype) as AgentActivity;
  Object.assign(activity, {
    speechQueue,
    _currentSpeech: undefined,
    _backgroundSpeeches: new Set<SpeechHandle>(),
    _preemptiveGeneration: undefined,
    realtimeSession: { interrupt: realtimeInterrupt },
    speechTasks: new Set(),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
  });
  return { activity, speechQueue, realtimeInterrupt, warn };
}

function enqueue(speechQueue: Heap<HeapItem>, speech: SpeechHandle, priority: number = 0): void {
  speechQueue.push([priority, sequence++, speech]);
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle._markDone();
  }
  sequence = 0;
});

describe('AgentActivity - interrupt protected queued speech', () => {
  it('stops the queue at the protected speech', () => {
    const { activity, speechQueue, realtimeInterrupt, warn } = makeActivity();
    const current = makeSpeech(true);
    const first = makeSpeech(true);
    const protectedSpeech = makeSpeech(false);
    const behind = makeSpeech(true);
    Object.assign(activity, { _currentSpeech: current });
    for (const speech of [first, protectedSpeech, behind]) {
      enqueue(speechQueue, speech);
    }

    expect(() => activity.interrupt()).not.toThrow();

    expect(current.interrupted).toBe(true);
    expect(first.interrupted).toBe(true);
    expect(protectedSpeech.interrupted).toBe(false);
    expect(behind.interrupted).toBe(false);
    expect(realtimeInterrupt).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('force: true'));
  });

  it('lets a protected head shield the whole queue', () => {
    const { activity, speechQueue } = makeActivity();
    const head = makeSpeech(false);
    const middle = makeSpeech(true);
    const tail = makeSpeech(false);
    for (const speech of [head, middle, tail]) {
      enqueue(speechQueue, speech);
    }

    activity.interrupt();

    expect(head.interrupted).toBe(false);
    expect(middle.interrupted).toBe(false);
    expect(tail.interrupted).toBe(false);
  });

  it('walks the queue in playout order rather than heap-array order', () => {
    const { activity, speechQueue } = makeActivity();
    const low = makeSpeech(true);
    const urgentProtected = makeSpeech(false);
    enqueue(speechQueue, low, SpeechHandle.SPEECH_PRIORITY_NORMAL);
    enqueue(speechQueue, urgentProtected, SpeechHandle.SPEECH_PRIORITY_HIGH);

    activity.interrupt();

    expect(urgentProtected.interrupted).toBe(false);
    expect(low.interrupted).toBe(false);
  });

  it('still throws for a protected playing speech', () => {
    const { activity } = makeActivity();
    Object.assign(activity, { _currentSpeech: makeSpeech(false) });

    expect(() => activity.interrupt()).toThrow();
  });

  it('force interrupts the whole chain', () => {
    const { activity, speechQueue, realtimeInterrupt } = makeActivity();
    const current = makeSpeech(false);
    const queued = makeSpeech(false);
    const behind = makeSpeech(true);
    Object.assign(activity, { _currentSpeech: current });
    for (const speech of [queued, behind]) {
      enqueue(speechQueue, speech);
    }

    activity.interrupt({ force: true });

    expect(current.interrupted).toBe(true);
    expect(queued.interrupted).toBe(true);
    expect(behind.interrupted).toBe(true);
    expect(realtimeInterrupt).toHaveBeenCalledOnce();
  });

  it('leaves an interruptible chain unaffected', () => {
    const { activity, speechQueue, realtimeInterrupt } = makeActivity();
    const current = makeSpeech(true);
    const queued = makeSpeech(true);
    Object.assign(activity, { _currentSpeech: current });
    enqueue(speechQueue, queued);

    activity.interrupt();

    expect(current.interrupted).toBe(true);
    expect(queued.interrupted).toBe(true);
    expect(realtimeInterrupt).toHaveBeenCalledOnce();
  });

  it('interrupts a queued reply while the scheduler owner finishes interrupted cleanup', async () => {
    const { activity, speechQueue } = makeActivity();
    const cleanupOwner = makeSpeech(true);
    const queuedReply = makeSpeech(true);
    const releasePauseCleanup = new Future<void>();
    cleanupOwner.interrupt();
    enqueue(speechQueue, queuedReply);

    Object.assign(activity, {
      _currentSpeech: cleanupOwner,
      _preemptiveGenerationCount: 0,
      _schedulingPaused: false,
      newTurnsBlocked: false,
      cancelSpeechPause: vi.fn(() => releasePauseCleanup.await),
      agent: {
        _llm: undefined,
        chatCtx: ChatContext.empty(),
        onUserTurnCompleted: vi.fn(async () => {}),
      },
      agentSession: { llm: undefined, emit: vi.fn() },
    });

    const turnCompletion = (
      activity as unknown as {
        userTurnCompleted(info: {
          newTranscript: string;
          transcriptConfidence: number;
          skipReply: boolean;
        }): Promise<void>;
      }
    ).userTurnCompleted({
      newTranscript: 'new user turn',
      transcriptConfidence: 1,
      skipReply: false,
    });

    expect(cleanupOwner.done()).toBe(false);
    expect(queuedReply.interrupted).toBe(true);

    releasePauseCleanup.resolve();
    await turnCompletion;
  });
});
