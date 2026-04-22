// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ExpFilter } from '../../utils.js';
import { DynamicEndpointing } from './endpointing.js';

describe('ExpFilter', () => {
  it('initialization with valid alpha', () => {
    const ema = new ExpFilter(0.5);
    expect(ema.value).toBeUndefined();

    const emaWithInitial = new ExpFilter(0.5, { initial: 10 });
    expect(emaWithInitial.value).toBe(10);

    expect(new ExpFilter(1.0).value).toBeUndefined();
  });

  it('initialization with invalid alpha', () => {
    expect(() => new ExpFilter(0.0)).toThrow(/alpha must be in/);
    expect(() => new ExpFilter(-0.5)).toThrow(/alpha must be in/);
    expect(() => new ExpFilter(1.5)).toThrow(/alpha must be in/);
  });

  it('update with no initial value', () => {
    const ema = new ExpFilter(0.5);
    const result = ema.apply(1.0, 10.0);
    expect(result).toBe(10);
    expect(ema.value).toBe(10);
  });

  it('update with initial value', () => {
    const ema = new ExpFilter(0.5, { initial: 10.0 });
    const result = ema.apply(1.0, 20.0);
    expect(result).toBe(15);
    expect(ema.value).toBe(15);
  });

  it('update multiple times', () => {
    const ema = new ExpFilter(0.5, { initial: 10.0 });
    ema.apply(1.0, 20.0);
    ema.apply(1.0, 20.0);
    expect(ema.value).toBe(17.5);
  });

  it('reset', () => {
    const ema = new ExpFilter(0.5, { initial: 10.0 });
    expect(ema.value).toBe(10);
    ema.reset();
    expect(ema.value).toBe(10);

    const emaWithInitial = new ExpFilter(0.5, { initial: 10.0 });
    emaWithInitial.reset({ initial: 5.0 });
    expect(emaWithInitial.value).toBe(5);
  });
});

describe('DynamicEndpointing', () => {
  it('initialization', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  it('initialization with custom alpha', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.2);
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  it('initialization uses updated default alpha', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect((ep as any).utterancePause.alpha).toBeCloseTo(0.9, 5);
    expect((ep as any).turnPause.alpha).toBeCloseTo(0.9, 5);
  });

  it('empty delays', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect(ep.betweenUtteranceDelay).toBe(0);
    expect(ep.betweenTurnDelay).toBe(0);
    expect(ep.immediateInterruptionDelay).toEqual([0, 0]);
  });

  it('on utterance ended', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    expect((ep as any).utteranceEndedAt).toBe(100000);

    const ep2 = new DynamicEndpointing(300, 1000);
    ep2.onEndOfSpeech(99900);
    expect((ep2 as any).utteranceEndedAt).toBe(99900);
  });

  it('on utterance started', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfSpeech(100000);
    expect((ep as any).utteranceStartedAt).toBe(100000);
  });

  it('on agent speech started', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfAgentSpeech(100000);
    expect((ep as any).agentSpeechStartedAt).toBe(100000);
  });

  it('between utterance delay calculation', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100500);
    expect(ep.betweenUtteranceDelay).toBeCloseTo(500, 5);
  });

  it('between turn delay calculation', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100800);
    expect(ep.betweenTurnDelay).toBeCloseTo(800, 5);
  });

  it('pause between utterances updates min delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100400);
    ep.onEndOfSpeech(100500, false);

    const expected = 0.5 * 400 + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('new turn updates max delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100600);
    ep.onStartOfSpeech(101500);
    ep.onEndOfSpeech(102000, false);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 600 + 0.5 * 1000, 5);
  });

  it('interruption updates min delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    expect((ep as any).agentSpeechStartedAt).toBeDefined();
    ep.onStartOfSpeech(100250, true);
    expect(ep.overlapping).toBe(true);

    ep.onEndOfSpeech(100500);

    expect(ep.overlapping).toBe(false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
    expect(ep.minDelay).toBeCloseTo(300, 5);
  });

  it('update options', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.updateOptions({ minDelay: 500 });
    expect(ep.minDelay).toBe(500);
    expect((ep as any).configuredMinDelay).toBe(500);

    const ep2 = new DynamicEndpointing(300, 1000);
    ep2.updateOptions({ maxDelay: 2000 });
    expect(ep2.maxDelay).toBe(2000);
    expect((ep2 as any).configuredMaxDelay).toBe(2000);

    const ep3 = new DynamicEndpointing(300, 1000);
    ep3.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect(ep3.minDelay).toBe(500);
    expect(ep3.maxDelay).toBe(2000);

    const ep4 = new DynamicEndpointing(300, 1000);
    ep4.updateOptions();
    expect(ep4.minDelay).toBe(300);
    expect(ep4.maxDelay).toBe(1000);
  });

  it('max delay clamped to configured max', () => {
    const ep = new DynamicEndpointing(300, 1000, 1.0);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(102000);
    ep.onStartOfSpeech(105000);
    expect(ep.maxDelay).toBe(1000);
  });

  it('max delay clamped to min delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 1.0);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100100);
    ep.onStartOfSpeech(100500);
    expect(ep.maxDelay).toBeGreaterThanOrEqual((ep as any).configuredMinDelay);
  });

  it('non interruption clears agent speech', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    expect((ep as any).agentSpeechStartedAt).toBeDefined();

    ep.onStartOfSpeech(102000);
    ep.onEndOfSpeech(103000, false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
  });

  it('consecutive interruptions only track first', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    ep.onStartOfSpeech(100250, true);

    expect(ep.overlapping).toBe(true);
    const previous = [ep.minDelay, ep.maxDelay];

    ep.onStartOfSpeech(100350);

    expect(ep.overlapping).toBe(true);
    expect([ep.minDelay, ep.maxDelay]).toEqual(previous);
  });

  it('delayed interruption updates max delay without crashing', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100900);
    ep.onStartOfSpeech(101800);
    ep.onEndOfSpeech(102000, false);
    expect(ep.maxDelay).toBeCloseTo(0.5 * 900 + 0.5 * 1000, 5);
  });

  it('interruption adjusts stale utterance end time', () => {
    const ep = new DynamicEndpointing(60, 1000, 1.0);
    ep.onEndOfSpeech(99000);
    ep.onStartOfSpeech(100000);

    ep.onStartOfAgentSpeech(100200);
    ep.onStartOfSpeech(100250, true);

    expect((ep as any).utteranceEndedAt).toBeCloseTo(100199, 5);
    expect(ep.minDelay).toBeCloseTo(60, 5);
    expect(ep.maxDelay).toBeCloseTo(1000, 5);
  });

  it('update options preserves filter alpha', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.updateOptions({ minDelay: 600, maxDelay: 2000 });
    expect((ep as any).utterancePause.alpha).toBeCloseTo(0.5, 5);
    expect((ep as any).turnPause.alpha).toBeCloseTo(0.5, 5);
  });

  it('update options updates filter clamp bounds', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect((ep as any).utterancePause.min).toBe(500);
    expect((ep as any).turnPause.max).toBe(2000);

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100200);
    expect(ep.minDelay).toBeCloseTo(500, 5);

    ep.onEndOfSpeech(101000);
    ep.onStartOfAgentSpeech(102800);
    ep.onStartOfSpeech(103500);
    expect(ep.maxDelay).toBeGreaterThan(1000);
    expect(ep.maxDelay).toBeLessThanOrEqual(2000);
  });

  it('should ignore skips filter update', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    ep.onStartOfSpeech(101500, true);

    const previousMin = ep.minDelay;
    const previousMax = ep.maxDelay;

    ep.onEndOfSpeech(101800, true);

    expect(ep.minDelay).toBe(previousMin);
    expect(ep.maxDelay).toBe(previousMax);
    expect((ep as any).utteranceStartedAt).toBeUndefined();
    expect((ep as any).utteranceEndedAt).toBeUndefined();
    expect(ep.overlapping).toBe(false);
    expect((ep as any).speaking).toBe(false);
  });

  it('should ignore without overlapping still updates', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100400, false);
    ep.onEndOfSpeech(100600, true);

    const expected = 0.5 * 400 + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('should ignore grace period overrides', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    ep.onStartOfSpeech(100600, true);
    ep.onEndOfSpeech(100800, true);

    expect((ep as any).utteranceEndedAt).toBe(100800);
    expect((ep as any).speaking).toBe(false);
  });

  it('should ignore outside grace period', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    ep.onStartOfSpeech(101000, true);

    const previousMin = ep.minDelay;
    const previousMax = ep.maxDelay;
    ep.onEndOfSpeech(101500, true);

    expect(ep.minDelay).toBe(previousMin);
    expect(ep.maxDelay).toBe(previousMax);
    expect((ep as any).utteranceStartedAt).toBeUndefined();
    expect((ep as any).utteranceEndedAt).toBeUndefined();
  });

  it('on end of agent speech clears state', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfAgentSpeech(100000);
    ep.onStartOfSpeech(100100, true);
    expect(ep.overlapping).toBe(true);
    expect((ep as any).agentSpeechStartedAt).toBe(100000);

    ep.onEndOfAgentSpeech(101000);

    expect((ep as any).agentSpeechEndedAt).toBe(101000);
    expect((ep as any).agentSpeechStartedAt).toBe(100000);
    expect(ep.overlapping).toBe(false);
  });

  it('overlapping inferred from agent speech', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100900);
    ep.onStartOfSpeech(101800, false);
    ep.onEndOfSpeech(102000);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 900 + 0.5 * 1000, 5);
  });

  it('speaking flag set and cleared', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect((ep as any).speaking).toBe(false);
    ep.onStartOfSpeech(100000);
    expect((ep as any).speaking).toBe(true);
    ep.onEndOfSpeech(100500);
    expect((ep as any).speaking).toBe(false);
  });

  it.each([
    ['no_agent/no_overlap/no_ignore', 'none', false, false, false, true, false],
    ['no_agent/no_overlap/ignore', 'none', false, true, false, true, false],
    ['agent_ended/no_overlap/no_ignore', 'ended', false, false, false, false, true],
    ['agent_ended/no_overlap/ignore', 'ended', false, true, false, false, true],
    ['agent_active/no_overlap/no_ignore', 'active', false, false, false, false, true],
    ['agent_active/no_overlap/ignore', 'active', false, true, false, false, true],
    ['agent_active/overlap/no_ignore', 'active', true, false, false, true, false],
    ['agent_active/overlap/ignore/outside_grace', 'active', true, true, false, false, false],
    ['agent_active/overlap/ignore/inside_grace', 'active', true, true, true, true, false],
  ])(
    'all overlapping and should_ignore combos: %s',
    (
      label,
      agentSpeech,
      overlapping,
      shouldIgnore,
      withinGrace,
      expectMinChange,
      expectMaxChange,
    ) => {
      const ep = new DynamicEndpointing(300, 1000, 0.5);

      ep.onStartOfSpeech(99000);
      ep.onEndOfSpeech(100000);

      let userStart = 100400;
      if (agentSpeech === 'ended') {
        ep.onStartOfAgentSpeech(100500);
        ep.onEndOfAgentSpeech(101000);
        userStart = 101500;
      } else if (agentSpeech === 'active') {
        if (withinGrace) {
          ep.onStartOfAgentSpeech(100150);
          userStart = 100350;
        } else if (overlapping && shouldIgnore) {
          ep.onStartOfAgentSpeech(100200);
          userStart = 101500;
        } else if (overlapping) {
          ep.onStartOfAgentSpeech(100150);
          userStart = 100400;
        } else {
          ep.onStartOfAgentSpeech(100900);
          userStart = 101800;
        }
      }

      ep.onStartOfSpeech(userStart, overlapping);

      const previousMin = ep.minDelay;
      const previousMax = ep.maxDelay;

      ep.onEndOfSpeech(userStart + 500, shouldIgnore);

      const minChanged = ep.minDelay !== previousMin;
      const maxChanged = ep.maxDelay !== previousMax;

      expect(minChanged, `[${label}] min_delay change`).toBe(expectMinChange);
      expect(maxChanged, `[${label}] max_delay change`).toBe(expectMaxChange);
      expect((ep as any).speaking, `[${label}] speaking`).toBe(false);
      expect(ep.overlapping, `[${label}] overlapping`).toBe(false);
    },
  );

  it('full conversation sequence', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onStartOfSpeech(100000);
    ep.onEndOfSpeech(101000);

    ep.onStartOfAgentSpeech(101500);

    ep.onStartOfSpeech(102500, true);
    const minBeforeBackchannel = ep.minDelay;
    const maxBeforeBackchannel = ep.maxDelay;
    ep.onEndOfSpeech(102800, true);

    expect(ep.minDelay).toBe(minBeforeBackchannel);
    expect(ep.maxDelay).toBe(maxBeforeBackchannel);

    ep.onEndOfAgentSpeech(103000);

    ep.onStartOfSpeech(103500);
    ep.onEndOfSpeech(104000);

    expect((ep as any).speaking).toBe(false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
  });
});
