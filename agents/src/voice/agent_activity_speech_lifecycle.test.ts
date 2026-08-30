// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AgentActivity, SchedulingPausedError } from './agent_activity.js';
import { SpeechHandle } from './speech_handle.js';

interface AgentActivitySpeechLifecycle {
  scheduleSpeech(speechHandle: SpeechHandle, priority: number, force?: boolean): void;
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
});
