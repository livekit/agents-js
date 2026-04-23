// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ExpFilter } from '../utils.js';
import { DynamicEndpointing } from './endpointing.js';

describe('ExponentialMovingAverage', () => {
  it('test_initialization_with_valid_alpha', () => {
    const ema = new ExpFilter(0.5);
    expect(ema.value).toBeUndefined();

    const emaWithInitial = new ExpFilter(0.5, { initial: 10.0 });
    expect(emaWithInitial.value).toBe(10.0);

    const alphaOne = new ExpFilter(1.0);
    expect(alphaOne.value).toBeUndefined();
  });

  it('test_initialization_with_invalid_alpha', () => {
    expect(() => new ExpFilter(0.0)).toThrowError(/alpha must be in/);
    expect(() => new ExpFilter(-0.5)).toThrowError(/alpha must be in/);
    expect(() => new ExpFilter(1.5)).toThrowError(/alpha must be in/);
  });

  it('test_update_with_no_initial_value', () => {
    const ema = new ExpFilter(0.5);
    const result = ema.apply(1.0, 10.0);
    expect(result).toBe(10.0);
    expect(ema.value).toBe(10.0);
  });

  it('test_update_with_initial_value', () => {
    const ema = new ExpFilter(0.5, { initial: 10.0 });
    const result = ema.apply(1.0, 20.0);
    expect(result).toBe(15.0);
    expect(ema.value).toBe(15.0);
  });

  it('test_update_multiple_times', () => {
    const ema = new ExpFilter(0.5, { initial: 10.0 });
    ema.apply(1.0, 20.0);
    ema.apply(1.0, 20.0);
    expect(ema.value).toBe(17.5);
  });

  it('test_reset', () => {
    const ema = new ExpFilter(0.5, { initial: 10.0 });
    expect(ema.value).toBe(10.0);
    ema.reset();
    expect(ema.value).toBe(10.0);

    const resetWithInitial = new ExpFilter(0.5, { initial: 10.0 });
    resetWithInitial.reset({ initial: 5.0 });
    expect(resetWithInitial.value).toBe(5.0);
  });
});

describe('DynamicEndpointing', () => {
  it('test_initialization', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);
    expect(ep.minDelay).toBe(0.3);
    expect(ep.maxDelay).toBe(1.0);
  });

  it('test_initialization_with_custom_alpha', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.2);
    expect(ep.minDelay).toBe(0.3);
    expect(ep.maxDelay).toBe(1.0);
  });

  it('test_initialization_uses_updated_default_alpha', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);
    expect(((ep as any).utterancePause as ExpFilter).alpha).toBeCloseTo(0.9, 5);
    expect(((ep as any).turnPause as ExpFilter).alpha).toBeCloseTo(0.9, 5);
  });

  it('test_empty_delays', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);
    expect(ep.betweenUtteranceDelay).toBe(0.0);
    expect(ep.betweenTurnDelay).toBe(0.0);
    expect(ep.immediateInterruptionDelay).toEqual([0.0, 0.0]);
  });

  it('test_on_utterance_ended', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);
    ep.onEndOfSpeech(100.0);
    expect((ep as any).utteranceEndedAt).toBe(100.0);

    const second = new DynamicEndpointing(0.3, 1.0);
    second.onEndOfSpeech(99.9);
    expect((second as any).utteranceEndedAt).toBe(99.9);
  });

  it('test_on_utterance_started', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);
    ep.onStartOfSpeech(100.0);
    expect((ep as any).utteranceStartedAt).toBe(100.0);
  });

  it('test_on_agent_speech_started', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);
    ep.onStartOfAgentSpeech(100.0);
    expect((ep as any).agentSpeechStartedAt).toBe(100.0);
  });

  it('test_between_utterance_delay_calculation', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);
    ep.onEndOfSpeech(100.0);
    ep.onStartOfSpeech(100.5);
    expect(ep.betweenUtteranceDelay).toBeCloseTo(0.5, 5);
  });

  it('test_between_turn_delay_calculation', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);
    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.8);
    expect(ep.betweenTurnDelay).toBeCloseTo(0.8, 5);
  });

  it('test_pause_between_utterances_updates_min_delay', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100.0);
    ep.onStartOfSpeech(100.4);
    ep.onEndOfSpeech(100.5, false);

    const expected = 0.5 * 0.4 + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('test_new_turn_updates_max_delay', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.6);
    ep.onStartOfSpeech(101.5);
    ep.onEndOfSpeech(102.0, false);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 0.6 + 0.5 * 1.0, 5);
  });

  it('test_interruption_updates_min_delay', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.2);
    expect((ep as any).agentSpeechStartedAt).toBeDefined();
    ep.onStartOfSpeech(100.25, true);
    expect(ep.overlapping).toBe(true);

    ep.onEndOfSpeech(100.5);

    expect(ep.overlapping).toBe(false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
    expect(ep.minDelay).toBeCloseTo(0.3, 5);
  });

  it('test_update_options', () => {
    const updateMin = new DynamicEndpointing(0.3, 1.0);
    updateMin.updateOptions({ minDelay: 0.5 });
    expect(updateMin.minDelay).toBe(0.5);
    expect((updateMin as any).minDelayValue).toBe(0.5);

    const updateMax = new DynamicEndpointing(0.3, 1.0);
    updateMax.updateOptions({ maxDelay: 2.0 });
    expect(updateMax.maxDelay).toBe(2.0);
    expect((updateMax as any).maxDelayValue).toBe(2.0);

    const updateBoth = new DynamicEndpointing(0.3, 1.0);
    updateBoth.updateOptions({ minDelay: 0.5, maxDelay: 2.0 });
    expect(updateBoth.minDelay).toBe(0.5);
    expect(updateBoth.maxDelay).toBe(2.0);

    const updateNone = new DynamicEndpointing(0.3, 1.0);
    updateNone.updateOptions({});
    expect(updateNone.minDelay).toBe(0.3);
    expect(updateNone.maxDelay).toBe(1.0);
  });

  it('test_max_delay_clamped_to_configured_max', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 1.0);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(102.0);
    ep.onStartOfSpeech(105.0);

    expect(ep.maxDelay).toBe(1.0);
  });

  it('test_max_delay_clamped_to_min_delay', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 1.0);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.1);
    ep.onStartOfSpeech(100.5);

    expect(ep.maxDelay).toBeGreaterThanOrEqual((ep as any).minDelayValue);
  });

  it('test_non_interruption_clears_agent_speech', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.5);
    expect((ep as any).agentSpeechStartedAt).toBeDefined();

    ep.onStartOfSpeech(102.0);
    ep.onEndOfSpeech(103.0, false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
  });

  it('test_consecutive_interruptions_only_track_first', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.2);
    ep.onStartOfSpeech(100.25, true);

    expect(ep.overlapping).toBe(true);
    const previous = [ep.minDelay, ep.maxDelay];

    ep.onStartOfSpeech(100.35);

    expect(ep.overlapping).toBe(true);
    expect([ep.minDelay, ep.maxDelay]).toEqual(previous);
  });

  it('test_delayed_interruption_updates_max_delay_without_crashing', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.9);
    ep.onStartOfSpeech(101.8);
    ep.onEndOfSpeech(102.0, false);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 0.9 + 0.5 * 1.0, 5);
  });

  it('test_interruption_adjusts_stale_utterance_end_time', () => {
    const ep = new DynamicEndpointing(0.06, 1.0, 1.0);

    ep.onEndOfSpeech(99.0);
    ep.onStartOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.2);
    ep.onStartOfSpeech(100.25, true);

    expect((ep as any).utteranceEndedAt).toBeCloseTo(100.199, 3);
    expect(ep.minDelay).toBeCloseTo(0.06, 5);
    expect(ep.maxDelay).toBeCloseTo(1.0, 5);
  });

  it('test_update_options_preserves_filter_alpha', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.updateOptions({ minDelay: 0.6, maxDelay: 2.0 });

    expect(((ep as any).utterancePause as ExpFilter).alpha).toBeCloseTo(0.5, 5);
    expect(((ep as any).turnPause as ExpFilter).alpha).toBeCloseTo(0.5, 5);
  });

  it('test_update_options_updates_filter_clamp_bounds', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.updateOptions({ minDelay: 0.5, maxDelay: 2.0 });
    expect(((ep as any).utterancePause as ExpFilter).min).toBe(0.5);
    expect(((ep as any).turnPause as ExpFilter).max).toBe(2.0);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfSpeech(100.2);
    expect(ep.minDelay).toBeCloseTo(0.5, 5);

    ep.onEndOfSpeech(101.0);
    ep.onStartOfAgentSpeech(102.8);
    ep.onStartOfSpeech(103.5);
    expect(ep.maxDelay).toBeGreaterThan(1.0);
    expect(ep.maxDelay).toBeLessThanOrEqual(2.0);
  });

  it('test_should_ignore_skips_filter_update', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.5);
    ep.onStartOfSpeech(351.5, true);

    const previousMin = ep.minDelay;
    const previousMax = ep.maxDelay;

    ep.onEndOfSpeech(351.8, true);

    expect(ep.minDelay).toBe(previousMin);
    expect(ep.maxDelay).toBe(previousMax);
    expect((ep as any).utteranceStartedAt).toBeUndefined();
    expect((ep as any).utteranceEndedAt).toBeUndefined();
    expect(ep.overlapping).toBe(false);
    expect((ep as any).speaking).toBe(false);
  });

  it('test_should_ignore_without_overlapping_still_updates', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100.0);
    ep.onStartOfSpeech(100.4, false);
    ep.onEndOfSpeech(100.6, true);

    const expected = 0.5 * 0.4 + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('test_should_ignore_grace_period_overrides', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.5);
    ep.onStartOfSpeech(100.6, true);
    ep.onEndOfSpeech(100.8, true);

    expect((ep as any).utteranceEndedAt).toBe(100.8);
    expect((ep as any).speaking).toBe(false);
  });

  it('test_should_ignore_outside_grace_period', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.5);
    ep.onStartOfSpeech(351.0, true);

    const previousMin = ep.minDelay;
    const previousMax = ep.maxDelay;
    ep.onEndOfSpeech(351.5, true);

    expect(ep.minDelay).toBe(previousMin);
    expect(ep.maxDelay).toBe(previousMax);
    expect((ep as any).utteranceStartedAt).toBeUndefined();
    expect((ep as any).utteranceEndedAt).toBeUndefined();
  });

  it('test_on_end_of_agent_speech_clears_state', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);

    ep.onStartOfAgentSpeech(100.0);
    ep.onStartOfSpeech(100.1, true);
    expect(ep.overlapping).toBe(true);
    expect((ep as any).agentSpeechStartedAt).toBe(100.0);

    ep.onEndOfAgentSpeech(101.0);

    expect((ep as any).agentSpeechEndedAt).toBe(101.0);
    expect((ep as any).agentSpeechStartedAt).toBe(100.0);
    expect(ep.overlapping).toBe(false);
  });

  it('test_overlapping_inferred_from_agent_speech', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.onEndOfSpeech(100.0);
    ep.onStartOfAgentSpeech(100.9);
    ep.onStartOfSpeech(101.8, false);
    ep.onEndOfSpeech(102.0);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 0.9 + 0.5 * 1.0, 5);
  });

  it('test_speaking_flag_set_and_cleared', () => {
    const ep = new DynamicEndpointing(0.3, 1.0);

    expect((ep as any).speaking).toBe(false);
    ep.onStartOfSpeech(100.0);
    expect((ep as any).speaking).toBe(true);
    ep.onEndOfSpeech(100.5);
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
    'test_all_overlapping_and_should_ignore_combos (%s)',
    (
      label,
      agentSpeech,
      overlapping,
      shouldIgnore,
      withinGrace,
      expectMinChange,
      expectMaxChange,
    ) => {
      const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

      ep.onStartOfSpeech(99.0);
      ep.onEndOfSpeech(100.0);

      let userStart = 100.4;
      if (agentSpeech === 'ended') {
        ep.onStartOfAgentSpeech(100.5);
        ep.onEndOfAgentSpeech(101.0);
        userStart = 101.5;
      } else if (agentSpeech === 'active') {
        if (withinGrace) {
          ep.onStartOfAgentSpeech(100.15);
          userStart = 100.35;
        } else if (overlapping && shouldIgnore) {
          ep.onStartOfAgentSpeech(100.2);
          userStart = 351.5;
        } else if (overlapping) {
          ep.onStartOfAgentSpeech(100.15);
          userStart = 100.4;
        } else {
          ep.onStartOfAgentSpeech(100.9);
          userStart = 101.8;
        }
      }

      ep.onStartOfSpeech(userStart, overlapping);

      const previousMin = ep.minDelay;
      const previousMax = ep.maxDelay;

      ep.onEndOfSpeech(userStart + 0.5, shouldIgnore);

      const minChanged = ep.minDelay !== previousMin;
      const maxChanged = ep.maxDelay !== previousMax;

      expect(
        minChanged,
        `[${label}] min_delay ${expectMinChange ? 'should' : 'should not'} change: ${previousMin} -> ${ep.minDelay}`,
      ).toBe(expectMinChange);
      expect(
        maxChanged,
        `[${label}] max_delay ${expectMaxChange ? 'should' : 'should not'} change: ${previousMax} -> ${ep.maxDelay}`,
      ).toBe(expectMaxChange);
      expect((ep as any).speaking, `[${label}] speaking should be false`).toBe(false);
      expect(ep.overlapping, `[${label}] overlapping should be false`).toBe(false);
    },
  );

  it('test_full_conversation_sequence', () => {
    const ep = new DynamicEndpointing(0.3, 1.0, 0.5);

    ep.onStartOfSpeech(100.0);
    ep.onEndOfSpeech(101.0);

    ep.onStartOfAgentSpeech(101.5);

    ep.onStartOfSpeech(352.5, true);
    const minBeforeBackchannel = ep.minDelay;
    const maxBeforeBackchannel = ep.maxDelay;
    ep.onEndOfSpeech(352.8, true);

    expect(ep.minDelay).toBe(minBeforeBackchannel);
    expect(ep.maxDelay).toBe(maxBeforeBackchannel);

    ep.onEndOfAgentSpeech(103.0);
    ep.onStartOfSpeech(103.5);
    ep.onEndOfSpeech(104.0);

    expect((ep as any).speaking).toBe(false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
  });
});
