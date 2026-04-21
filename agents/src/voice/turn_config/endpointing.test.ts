// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { DynamicEndpointing, createEndpointing } from './endpointing.js';

// Ref: python tests/test_endpointing.py - 64-545 lines
describe('DynamicEndpointing', () => {
  it('creates a dynamic endpointing runtime from config', () => {
    const endpointing = createEndpointing({ mode: 'dynamic', minDelay: 300, maxDelay: 1000 });

    expect(endpointing).toBeInstanceOf(DynamicEndpointing);
    expect(endpointing.minDelay).toBe(300);
    expect(endpointing.maxDelay).toBe(1000);
  });

  it('updates minDelay from pauses between utterances', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 }, 0.5);

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfSpeech(100_400);
    endpointing.onEndOfSpeech(100_500);

    expect(endpointing.minDelay).toBeCloseTo(350, 5);
  });

  it('updates maxDelay from a delayed new turn after agent speech', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 }, 0.5);

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_600);
    endpointing.onStartOfSpeech(101_500);
    endpointing.onEndOfSpeech(102_000);

    expect(endpointing.maxDelay).toBeCloseTo(800, 5);
  });

  it('updates minDelay for immediate interruptions', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 200, maxDelay: 1000 }, 0.5);

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_150);
    endpointing.onStartOfSpeech(100_350, true);
    endpointing.onEndOfSpeech(100_500);

    expect(endpointing.minDelay).toBeCloseTo(275, 5);
  });

  it('skips EMA updates for backchannels outside the grace period', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 }, 0.5);

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_500);
    endpointing.onStartOfSpeech(101_500, true);

    const previousMinDelay = endpointing.minDelay;
    const previousMaxDelay = endpointing.maxDelay;

    endpointing.onEndOfSpeech(101_800, true);

    expect(endpointing.minDelay).toBe(previousMinDelay);
    expect(endpointing.maxDelay).toBe(previousMaxDelay);
    expect((endpointing as any)._utteranceStartedAt).toBeUndefined();
    expect((endpointing as any)._utteranceEndedAt).toBeUndefined();
  });

  it('overrides shouldIgnore within the agent speech grace period', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 }, 0.5);

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_500);
    endpointing.onStartOfSpeech(100_600, true);
    endpointing.onEndOfSpeech(100_800, true);

    expect(endpointing.minDelay).toBeCloseTo(450, 5);
  });
});
