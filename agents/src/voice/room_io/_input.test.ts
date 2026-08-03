// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ParticipantAudioInputStream } from './_input.js';

type InputInternals = {
  frameProcessor: { close: () => void } | undefined;
  processorOwned: boolean;
  updateProcessor: (p: { close: () => void } | undefined) => void;
};

/**
 * Ref: python livekit-agents/livekit/agents/voice/room_io/_input.py
 *
 * Mirrors the Python PR (livekit/agents#5467) lifecycle invariants for the
 * subset of behaviors that apply to agents-js — i.e. externally-provided
 * FrameProcessor instances. The JS API does not currently accept a
 * selector callable, so selector-owned scenarios are N/A here.
 */
describe('ParticipantAudioInputStream processor ownership', () => {
  const makeInternal = (
    frameProcessor: { close: () => void } | undefined,
    processorOwned: boolean,
  ): InputInternals => {
    const target = Object.create(ParticipantAudioInputStream.prototype) as InputInternals;
    target.frameProcessor = frameProcessor;
    target.processorOwned = processorOwned;
    return target;
  };

  it('updateProcessor(undefined) is a no-op for externally-provided processors', () => {
    const external = { close: vi.fn() };
    const target = makeInternal(external, false);

    target.updateProcessor(undefined);

    expect(external.close).not.toHaveBeenCalled();
    expect(target.frameProcessor).toBe(external);
    expect(target.processorOwned).toBe(false);
  });

  it('updateProcessor(undefined) closes and clears an owned processor', () => {
    const owned = { close: vi.fn() };
    const target = makeInternal(owned, true);

    target.updateProcessor(undefined);

    expect(owned.close).toHaveBeenCalledTimes(1);
    expect(target.frameProcessor).toBeUndefined();
    expect(target.processorOwned).toBe(false);
  });

  it('updateProcessor(new) replaces and closes an owned predecessor', () => {
    const oldOwned = { close: vi.fn() };
    const replacement = { close: vi.fn() };
    const target = makeInternal(oldOwned, true);

    target.updateProcessor(replacement);

    expect(oldOwned.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(target.frameProcessor).toBe(replacement);
    expect(target.processorOwned).toBe(true);
  });

  it('updateProcessor(same processor) does not close itself', () => {
    const proc = { close: vi.fn() };
    const target = makeInternal(proc, true);

    target.updateProcessor(proc);

    expect(proc.close).not.toHaveBeenCalled();
    expect(target.frameProcessor).toBe(proc);
    expect(target.processorOwned).toBe(true);
  });
});
