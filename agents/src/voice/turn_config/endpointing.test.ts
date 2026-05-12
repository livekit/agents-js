// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { BaseEndpointing, DynamicEndpointing, createEndpointing } from './endpointing.js';

describe('DynamicEndpointing', () => {
  it('initializes with configured delays', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });

    expect(endpointing.minDelay).toBe(300);
    expect(endpointing.maxDelay).toBe(1000);
  });

  it('updates minDelay from pauses between utterances', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfSpeech(100_400);
    endpointing.onEndOfSpeech(100_500);

    expect(endpointing.minDelay).toBeCloseTo(350);
  });

  it('updates maxDelay from pauses before a new turn', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_600);
    endpointing.onStartOfSpeech(101_500);
    endpointing.onEndOfSpeech(102_000);

    expect(endpointing.maxDelay).toBeCloseTo(800);
  });

  it('skips updates for ignored overlapping speech outside the grace period', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_500);
    endpointing.onStartOfSpeech(101_500, true);

    const previousMinDelay = endpointing.minDelay;
    const previousMaxDelay = endpointing.maxDelay;
    endpointing.onEndOfSpeech(101_800, true);

    expect(endpointing.minDelay).toBe(previousMinDelay);
    expect(endpointing.maxDelay).toBe(previousMaxDelay);
  });

  it('updates options and clamps learned delays', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.updateOptions({ minDelay: 500, maxDelay: 2000 });
    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfSpeech(100_200);

    expect(endpointing.minDelay).toBeCloseTo(500);

    endpointing.onEndOfSpeech(101_000);
    endpointing.onStartOfAgentSpeech(102_800);
    endpointing.onStartOfSpeech(103_500);

    expect(endpointing.maxDelay).toBeGreaterThan(1000);
    expect(endpointing.maxDelay).toBeLessThanOrEqual(2000);
  });
});

describe('createEndpointing', () => {
  it('creates dynamic endpointing for dynamic mode', () => {
    const endpointing = createEndpointing({
      mode: 'dynamic',
      minDelay: 300,
      maxDelay: 1000,
      alpha: 0.7,
    });

    expect(endpointing).toBeInstanceOf(DynamicEndpointing);
  });

  it('creates base endpointing for fixed mode', () => {
    const endpointing = createEndpointing({
      mode: 'fixed',
      minDelay: 500,
      maxDelay: 3000,
      alpha: 0.9,
    });

    expect(endpointing).toBeInstanceOf(BaseEndpointing);
    expect(endpointing).not.toBeInstanceOf(DynamicEndpointing);
    expect(endpointing.minDelay).toBe(500);
    expect(endpointing.maxDelay).toBe(3000);
  });
});
