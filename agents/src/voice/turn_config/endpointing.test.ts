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

  it('does not change fixed maxDelay from pauses before a new turn', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_600);
    endpointing.onStartOfSpeech(101_500);
    endpointing.onEndOfSpeech(102_000);

    expect(endpointing.maxDelay).toBeCloseTo(1000);
  });

  it('keeps maxDelay at the configured value regardless of observed pauses', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 1 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(102_000);
    endpointing.onStartOfSpeech(105_000);
    endpointing.onEndOfSpeech(105_500);

    expect(endpointing.maxDelay).toBeCloseTo(1000);
  });

  it('clamps minDelay to the fixed maxDelay ceiling', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });

    endpointing.updateOptions({ minDelay: 1500 });

    expect(endpointing.minDelay).toBeCloseTo(1000);
    expect(endpointing.maxDelay).toBeCloseTo(1000);
  });

  it('clamps an already-learned minDelay when maxDelay is lowered', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfSpeech(101_000);
    endpointing.onEndOfSpeech(101_500);
    expect(endpointing.minDelay).toBeCloseTo(650);

    endpointing.updateOptions({ maxDelay: 500 });

    expect(endpointing.minDelay).toBeCloseTo(500);
    expect(endpointing.maxDelay).toBeCloseTo(500);
  });

  it('skips updates for a confirmed non-interruption outside the grace period', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_500);
    endpointing.onStartOfSpeech(101_500, true);

    const previousMinDelay = endpointing.minDelay;
    const previousMaxDelay = endpointing.maxDelay;
    endpointing.onEndOfSpeech(101_800, false);

    expect(endpointing.minDelay).toBe(previousMinDelay);
    expect(endpointing.maxDelay).toBe(previousMaxDelay);
  });

  it('uses a non-interruption verdict normally without overlap', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfSpeech(100_400, false);
    endpointing.onEndOfSpeech(100_600, false);

    expect(endpointing.minDelay).toBeCloseTo(350);
  });

  it('overrides a non-interruption verdict within the leading-silence grace period', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_500);
    endpointing.onStartOfSpeech(100_600, true);
    endpointing.onEndOfSpeech(100_800, false);

    expect(endpointing.minDelay).toBeCloseTo(450);
    expect(endpointing.overlapping).toBe(false);
  });

  it('preserves an ongoing overlap when agent speech resumes', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_200);
    endpointing.onStartOfSpeech(100_400, true);
    endpointing.onEndOfAgentSpeech(100_600);
    endpointing.onStartOfAgentSpeech(100_700);

    expect(endpointing.overlapping).toBe(true);

    endpointing.onEndOfSpeech(101_000, false);

    expect(endpointing.minDelay).toBe(300);
  });

  it('updates options and clamps learned delays', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.updateOptions({ minDelay: 500, maxDelay: 2000 });
    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfSpeech(100_200);

    expect(endpointing.minDelay).toBeCloseTo(500);

    expect(endpointing.maxDelay).toBeCloseTo(2000);
  });

  it('leaves delays unchanged for delayed interruptions', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_900);
    endpointing.onStartOfSpeech(101_800);
    endpointing.onEndOfSpeech(102_000);

    expect(endpointing.minDelay).toBeCloseTo(300);
    expect(endpointing.maxDelay).toBeCloseTo(1000);
  });

  it('leaves delays unchanged when the next user turn starts after agent speech ends', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_600);
    endpointing.onEndOfAgentSpeech(101_200);
    const previousMinDelay = endpointing.minDelay;
    const previousMaxDelay = endpointing.maxDelay;

    endpointing.onStartOfSpeech(101_500);
    endpointing.onEndOfSpeech(102_000);

    expect(endpointing.minDelay).toBe(previousMinDelay);
    expect(endpointing.maxDelay).toBe(previousMaxDelay);
  });

  it('preserves active agent speech when overlapping user speech ends', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_500);
    endpointing.onStartOfSpeech(102_000, true);
    endpointing.onEndOfSpeech(103_000);
    endpointing.onEndOfAgentSpeech(105_000);
    endpointing.onStartOfSpeech(106_000);
    endpointing.onEndOfSpeech(108_000);

    expect(endpointing.minDelay).toBe(300);
  });

  it('does not reuse an agent speech start for a later overlap', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 100, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfAgentSpeech(100_200);
    endpointing.onStartOfSpeech(100_250, true);
    endpointing.onEndOfSpeech(100_300);
    expect(endpointing.minDelay).toBeCloseTo(175);

    endpointing.onStartOfSpeech(100_400, true);
    endpointing.onEndOfSpeech(100_500);

    expect(endpointing.minDelay).toBeCloseTo(175);
  });

  it('replaces a completed agent interval when agent speech starts during user speech', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1400, alpha: 0.7 });

    endpointing.onEndOfSpeech(0);
    endpointing.onStartOfAgentSpeech(200);
    endpointing.onEndOfAgentSpeech(600);
    endpointing.onStartOfSpeech(1000);
    endpointing.onStartOfAgentSpeech(1200);
    endpointing.onEndOfSpeech(1400);

    expect(endpointing.minDelay).toBeCloseTo(300);
  });

  it('ignores a duplicate agent speech end after its marker was consumed', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onStartOfAgentSpeech(100_000);
    endpointing.onEndOfAgentSpeech(101_000);
    endpointing.onStartOfSpeech(101_500);
    endpointing.onEndOfSpeech(102_000);
    endpointing.onEndOfAgentSpeech(102_500);
    endpointing.onStartOfSpeech(102_400);
    endpointing.onEndOfSpeech(102_600);

    expect(endpointing.minDelay).toBeCloseTo(350);
  });

  it.each([
    {
      label: 'no agent/no overlap/unknown',
      agentSpeech: 'none',
      overlapping: false,
      interruption: undefined,
      withinGrace: false,
      minChanges: true,
    },
    {
      label: 'no agent/no overlap/non-interruption',
      agentSpeech: 'none',
      overlapping: false,
      interruption: false,
      withinGrace: false,
      minChanges: true,
    },
    {
      label: 'agent ended/no overlap/unknown',
      agentSpeech: 'ended',
      overlapping: false,
      interruption: undefined,
      withinGrace: false,
      minChanges: false,
    },
    {
      label: 'agent ended/no overlap/non-interruption',
      agentSpeech: 'ended',
      overlapping: false,
      interruption: false,
      withinGrace: false,
      minChanges: false,
    },
    {
      label: 'agent active/no overlap/unknown',
      agentSpeech: 'active',
      overlapping: false,
      interruption: undefined,
      withinGrace: false,
      minChanges: false,
    },
    {
      label: 'agent active/no overlap/non-interruption',
      agentSpeech: 'active',
      overlapping: false,
      interruption: false,
      withinGrace: false,
      minChanges: false,
    },
    {
      label: 'agent active/overlap/unknown',
      agentSpeech: 'active',
      overlapping: true,
      interruption: undefined,
      withinGrace: false,
      minChanges: true,
    },
    {
      label: 'agent active/overlap/interruption',
      agentSpeech: 'active',
      overlapping: true,
      interruption: true,
      withinGrace: false,
      minChanges: true,
    },
    {
      label: 'agent active/overlap/non-interruption/outside grace',
      agentSpeech: 'active',
      overlapping: true,
      interruption: false,
      withinGrace: false,
      minChanges: false,
    },
    {
      label: 'agent active/overlap/non-interruption/inside grace',
      agentSpeech: 'active',
      overlapping: true,
      interruption: false,
      withinGrace: true,
      minChanges: true,
    },
  ] as const)(
    'handles $label',
    ({ agentSpeech, overlapping, interruption, withinGrace, minChanges }) => {
      const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });
      endpointing.onStartOfSpeech(99_000);
      endpointing.onEndOfSpeech(100_000);

      let userStart = 100_400;
      if (agentSpeech === 'ended') {
        endpointing.onStartOfAgentSpeech(100_500);
        endpointing.onEndOfAgentSpeech(101_000);
        userStart = 101_500;
      } else if (agentSpeech === 'active') {
        if (withinGrace) {
          endpointing.onStartOfAgentSpeech(100_150);
          userStart = 100_350;
        } else if (overlapping && interruption === false) {
          endpointing.onStartOfAgentSpeech(100_200);
          userStart = 101_500;
        } else if (overlapping) {
          endpointing.onStartOfAgentSpeech(100_150);
          userStart = 100_400;
        } else {
          endpointing.onStartOfAgentSpeech(100_900);
          userStart = 101_800;
        }
      }

      endpointing.onStartOfSpeech(userStart, overlapping);
      const previousMinDelay = endpointing.minDelay;
      const previousMaxDelay = endpointing.maxDelay;
      endpointing.onEndOfSpeech(userStart + 500, interruption);

      expect(endpointing.minDelay !== previousMinDelay).toBe(minChanges);
      expect(endpointing.maxDelay).toBe(previousMaxDelay);
      expect(endpointing.overlapping).toBe(false);
    },
  );

  it('handles a full conversation with a confirmed backchannel', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onStartOfSpeech(100_000);
    endpointing.onEndOfSpeech(101_000);
    endpointing.onStartOfAgentSpeech(101_500);
    endpointing.onStartOfSpeech(102_500, true);
    const previousMinDelay = endpointing.minDelay;
    endpointing.onEndOfSpeech(102_800, false);
    endpointing.onEndOfAgentSpeech(103_000);
    endpointing.onStartOfSpeech(103_500);
    endpointing.onEndOfSpeech(104_000);

    expect(endpointing.minDelay).toBe(previousMinDelay);
    expect(endpointing.overlapping).toBe(false);
  });

  it.each([
    { label: 'unknown', interruption: undefined, overlapStartedAt: 500 },
    { label: 'confirmed interruption', interruption: true, overlapStartedAt: 500 },
    {
      label: 'confirmed backchannel within grace period',
      interruption: false,
      overlapStartedAt: 100,
    },
  ])(
    'does not learn agent speech as a user pause for $label',
    ({ interruption, overlapStartedAt }) => {
      const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1400, alpha: 0.7 });

      endpointing.onStartOfAgentSpeech(0);
      endpointing.onStartOfSpeech(overlapStartedAt, true);
      endpointing.onEndOfSpeech(overlapStartedAt + 300, interruption);
      endpointing.onEndOfAgentSpeech(5000);
      endpointing.onStartOfSpeech(6000);
      endpointing.onEndOfSpeech(8000);

      expect(endpointing.minDelay).toBe(300);
    },
  );

  it('updates alpha in place without resetting learned state', () => {
    const endpointing = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    endpointing.onEndOfSpeech(100_000);
    endpointing.onStartOfSpeech(101_000);
    endpointing.onEndOfSpeech(101_500);
    const learnedMinDelay = endpointing.minDelay;
    expect(learnedMinDelay).toBeCloseTo(650);

    endpointing.updateOptions({ alpha: 0.2 });

    expect(endpointing.minDelay).toBeCloseTo(learnedMinDelay);
    endpointing.onStartOfSpeech(102_500);
    endpointing.onEndOfSpeech(103_000);
    expect(endpointing.minDelay).toBeCloseTo(930);
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
