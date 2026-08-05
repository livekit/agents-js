// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AgentInput, AudioInput } from './io.js';

class TestAudioInput extends AudioInput {
  override onAttached = vi.fn();
  override onDetached = vi.fn();
}

describe('AgentInput', () => {
  it('detaches replaced audio and synchronizes the new stream with the disabled state', () => {
    const audioChanged = vi.fn();
    const agentInput = new AgentInput(audioChanged);
    const original = new TestAudioInput();
    const replacement = new TestAudioInput();

    agentInput.audio = original;
    expect(original.onAttached).toHaveBeenCalledOnce();

    agentInput.setAudioEnabled(false);
    expect(original.onDetached).toHaveBeenCalledOnce();

    agentInput.audio = replacement;
    expect(original.onDetached).toHaveBeenCalledTimes(2);
    expect(replacement.onDetached).toHaveBeenCalledOnce();
    expect(replacement.onAttached).not.toHaveBeenCalled();

    agentInput.audio = replacement;
    expect(audioChanged).toHaveBeenCalledTimes(2);
    expect(replacement.onDetached).toHaveBeenCalledOnce();
  });
});
