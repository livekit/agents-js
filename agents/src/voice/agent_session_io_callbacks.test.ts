// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from './agent_session.js';
import { AudioInput } from './io.js';

class TestAudioInput extends AudioInput {}

function startedSession() {
  const session = new AgentSession();
  const activity = { attachAudioInput: vi.fn() };
  (session as any).started = true;
  (session as any).activity = activity;
  return { session, activity };
}

describe('AgentSession IO callbacks', () => {
  it('attaches a new audio input to the running activity', () => {
    const { session, activity } = startedSession();
    const input = new TestAudioInput();

    session.input.audio = input;

    expect(activity.attachAudioInput).toHaveBeenCalledWith(input.stream);
  });

  it('warns when a started session gets an audio output that cannot pause', () => {
    const { session } = startedSession();
    const warn = vi.spyOn((session as any).logger, 'warn').mockImplementation(() => {});
    const output = { canPause: false, onAttached: vi.fn(), onDetached: vi.fn() };

    session.output.audio = output as any;

    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      'resumeFalseInterruption is enabled, but the audio output does not support pause, ignored',
    );
  });
});
