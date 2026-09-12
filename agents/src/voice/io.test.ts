// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { AgentInput, AgentOutput, AudioInput, AudioOutput } from './io.js';

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

class TestAudioOutput extends AudioOutput {
  captureFrame = vi.fn(async (frame: AudioFrame) => super.captureFrame(frame));
  override flush = vi.fn(() => super.flush());
  override clearBuffer = vi.fn();
  override onAttached = vi.fn();
  override onDetached = vi.fn();
}

class TestAudioWrapper extends AudioOutput {
  constructor(next: AudioOutput) {
    super(next.sampleRate, next, { pause: true });
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    await this.nextInChain!.captureFrame(frame);
  }

  override flush(): void {
    super.flush();
    this.nextInChain!.flush();
  }

  override clearBuffer(): void {
    this.nextInChain!.clearBuffer();
  }
}

describe('AgentOutput.replaceAudioTail', () => {
  it('replaces a bare output directly', () => {
    const output = new AgentOutput(() => {});
    const original = new TestAudioOutput();
    const replacement = new TestAudioOutput();
    output.audio = original;

    output.replaceAudioTail(replacement);

    expect(output.audio).toBe(replacement);
    expect(original.onDetached).toHaveBeenCalledOnce();
    expect(replacement.onAttached).toHaveBeenCalledOnce();
  });

  it('keeps wrappers and settles a flushed segment when swapping the leaf', async () => {
    const output = new AgentOutput(() => {});
    const original = new TestAudioOutput();
    const replacement = new TestAudioOutput();
    const wrapper = new TestAudioWrapper(original);
    output.audio = wrapper;
    const frame = { samplesPerChannel: 480, sampleRate: 24000 } as AudioFrame;
    await wrapper.captureFrame(frame);
    wrapper.flush();

    output.replaceAudioTail(replacement);

    expect(output.audio).toBe(wrapper);
    expect(original.flush).toHaveBeenCalledOnce();
    expect(original.clearBuffer).toHaveBeenCalledOnce();
    await expect(wrapper.waitForPlayout()).resolves.toMatchObject({ interrupted: true });
    await wrapper.captureFrame(frame);
    expect(replacement.captureFrame).toHaveBeenCalledWith(frame);
  });
});
