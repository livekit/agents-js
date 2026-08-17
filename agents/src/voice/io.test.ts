// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AgentInput, AudioInput } from './io.js';

class TestAudioInput extends AudioInput {
  override setAttached = vi.fn();
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
    expect(original.setAttached).toHaveBeenCalledWith(true);
    expect(original.onAttached).toHaveBeenCalledOnce();

    agentInput.setAudioEnabled(false);
    expect(original.setAttached).toHaveBeenCalledWith(false);
    expect(original.onDetached).toHaveBeenCalledOnce();

    agentInput.audio = replacement;
    expect(original.setAttached).toHaveBeenCalledWith(false);
    expect(original.onDetached).toHaveBeenCalledTimes(2);
    expect(replacement.setAttached).toHaveBeenCalledWith(false);
    expect(replacement.onDetached).toHaveBeenCalledOnce();
    expect(replacement.onAttached).not.toHaveBeenCalled();

    agentInput.audio = replacement;
    expect(audioChanged).toHaveBeenCalledTimes(2);
    expect(replacement.onDetached).toHaveBeenCalledOnce();
  });

  it('flips attach state before lifecycle hooks', () => {
    const order: string[] = [];
    class OrderedAudioInput extends AudioInput {
      override setAttached(attached: boolean): void {
        order.push(`setAttached:${attached}`);
      }
      override onAttached(): void {
        order.push('onAttached');
      }
      override onDetached(): void {
        order.push('onDetached');
      }
    }

    const agentInput = new AgentInput(() => {});
    const audio = new OrderedAudioInput();
    agentInput.audio = audio;
    agentInput.setAudioEnabled(false);

    expect(order).toEqual(['setAttached:true', 'onAttached', 'setAttached:false', 'onDetached']);
  });
});
