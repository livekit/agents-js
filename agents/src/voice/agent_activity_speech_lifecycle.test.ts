// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { Future, type Task } from '../utils.js';
import { AgentActivity, SchedulingPausedError } from './agent_activity.js';
import { SpeechHandle } from './speech_handle.js';

interface AgentActivitySpeechLifecycle {
  scheduleSpeech(speechHandle: SpeechHandle, priority: number, force?: boolean): void;
  createSpeechTask(options: {
    taskFn: (controller: AbortController) => Promise<void>;
    controller?: AbortController;
    ownedSpeechHandle?: SpeechHandle;
    inlineTask?: boolean;
    name?: string;
  }): Task<void>;
}

const activityLifecycle = AgentActivity.prototype as unknown as AgentActivitySpeechLifecycle;

describe('AgentActivity speech lifecycle', () => {
  it('interrupts speech refused while scheduling is paused', () => {
    const warn = vi.fn();
    const activity = Object.assign(Object.create(AgentActivity.prototype), {
      _schedulingPaused: true,
      logger: { warn },
    }) as AgentActivity;
    const speechHandle = SpeechHandle.create({ allowInterruptions: false });

    try {
      expect(() =>
        activityLifecycle.scheduleSpeech.call(
          activity,
          speechHandle,
          SpeechHandle.SPEECH_PRIORITY_NORMAL,
        ),
      ).toThrow(SchedulingPausedError);
      expect(speechHandle.interrupted).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      speechHandle._markDone();
    }
  });

  it('interrupts speech when the scheduling task has already stopped', () => {
    const warn = vi.fn();
    const activity = Object.assign(Object.create(AgentActivity.prototype), {
      _schedulingPaused: false,
      _mainTask: { done: true },
      logger: { warn },
    }) as AgentActivity;
    const speechHandle = SpeechHandle.create({ allowInterruptions: false });

    try {
      expect(() =>
        activityLifecycle.scheduleSpeech.call(
          activity,
          speechHandle,
          SpeechHandle.SPEECH_PRIORITY_NORMAL,
        ),
      ).not.toThrow();
      expect(speechHandle.interrupted).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      speechHandle._markDone();
    }
  });

  it('interrupts owned speech when its task is canceled', async () => {
    const speechTasks = new Set<Task<void>>();
    const activity = Object.assign(Object.create(AgentActivity.prototype), {
      speechTasks,
      wakeupMainTask: vi.fn(),
    }) as AgentActivity;
    const speechHandle = SpeechHandle.create({ allowInterruptions: false });
    const taskStarted = new Future<void>();
    const task = activityLifecycle.createSpeechTask.call(activity, {
      taskFn: async (controller) => {
        taskStarted.resolve();
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      ownedSpeechHandle: speechHandle,
      name: 'owned-speech-test',
    });

    await taskStarted.await;
    await task.cancelAndWait();

    expect(task.done).toBe(true);
    expect(speechHandle.interrupted).toBe(true);
  });
});
