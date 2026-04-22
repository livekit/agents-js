// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ExpFilter } from '../utils.js';
import { DynamicEndpointing } from './endpointing.js';

const SECOND = 1000;

function expFilterState(filter: ExpFilter) {
  return filter as unknown as {
    alpha: number;
    minValue?: number;
    maxValue?: number;
  };
}

function endpointingState(endpointing: DynamicEndpointing) {
  return endpointing as unknown as {
    utterancePause: ExpFilter;
    turnPause: ExpFilter;
    utteranceStartedAt?: number;
    utteranceEndedAt?: number;
    agentSpeechStartedAt?: number;
    agentSpeechEndedAt?: number;
    speaking: boolean;
  };
}

// Ref: python tests/test_endpointing.py - 7-63 lines
describe('TestExponentialMovingAverage', () => {
  it('test_initialization_with_valid_alpha', () => {
    let ema = new ExpFilter(0.5);
    expect(ema.value).toBeUndefined();

    const emaWithInitial = new ExpFilter(0.5, { initial: 10.0 });
    expect(emaWithInitial.value).toBe(10.0);

    ema = new ExpFilter(1.0);
    expect(ema.value).toBeUndefined();
  });

  it('test_initialization_with_invalid_alpha', () => {
    expect(() => new ExpFilter(0.0)).toThrow('alpha must be in');
    expect(() => new ExpFilter(-0.5)).toThrow('alpha must be in');
    expect(() => new ExpFilter(1.5)).toThrow('alpha must be in');
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
    let ema = new ExpFilter(0.5, { initial: 10.0 });
    expect(ema.value).toBe(10.0);
    ema.reset();
    expect(ema.value).toBe(10.0);

    ema = new ExpFilter(0.5, { initial: 10.0 });
    ema.reset({ initial: 5.0 });
    expect(ema.value).toBe(5.0);
  });
});

// Ref: python tests/test_endpointing.py - 64-545 lines
describe('TestDynamicEndpointing', () => {
  it('test_initialization', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    expect(ep.minDelay).toBe(0.3 * SECOND);
    expect(ep.maxDelay).toBe(1.0 * SECOND);
  });

  it('test_initialization_with_custom_alpha', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.2,
    });
    expect(ep.minDelay).toBe(0.3 * SECOND);
    expect(ep.maxDelay).toBe(1.0 * SECOND);
  });

  it('test_initialization_uses_updated_default_alpha', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    const state = endpointingState(ep);
    expect(expFilterState(state.utterancePause).alpha).toBeCloseTo(0.9, 5);
    expect(expFilterState(state.turnPause).alpha).toBeCloseTo(0.9, 5);
  });

  it('test_empty_delays', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    expect(ep.betweenUtteranceDelay).toBe(0);
    expect(ep.betweenTurnDelay).toBe(0);
    expect(ep.immediateInterruptionDelay).toEqual([0, 0]);
  });

  it('test_on_utterance_ended', () => {
    let ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    ep.onEndOfSpeech(100 * SECOND);
    expect(endpointingState(ep).utteranceEndedAt).toBe(100 * SECOND);

    ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    ep.onEndOfSpeech(99.9 * SECOND);
    expect(endpointingState(ep).utteranceEndedAt).toBe(99.9 * SECOND);
  });

  it('test_on_utterance_started', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    ep.onStartOfSpeech(100 * SECOND);
    expect(endpointingState(ep).utteranceStartedAt).toBe(100 * SECOND);
  });

  it('test_on_agent_speech_started', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    ep.onStartOfAgentSpeech(100 * SECOND);
    expect(endpointingState(ep).agentSpeechStartedAt).toBe(100 * SECOND);
  });

  it('test_between_utterance_delay_calculation', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfSpeech(100.5 * SECOND);

    expect(ep.betweenUtteranceDelay).toBeCloseTo(0.5 * SECOND, 5);
  });

  it('test_between_turn_delay_calculation', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfAgentSpeech(100.8 * SECOND);

    expect(ep.betweenTurnDelay).toBeCloseTo(0.8 * SECOND, 5);
  });

  it('test_pause_between_utterances_updates_min_delay', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfSpeech(100.4 * SECOND);
    ep.onEndOfSpeech(100.5 * SECOND, { shouldIgnore: false });

    const expected = 0.5 * 0.4 * SECOND + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('test_new_turn_updates_max_delay', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfAgentSpeech(100.6 * SECOND);
    ep.onStartOfSpeech(101.5 * SECOND);
    ep.onEndOfSpeech(102.0 * SECOND, { shouldIgnore: false });

    expect(ep.maxDelay).toBeCloseTo(0.5 * 0.6 * SECOND + 0.5 * 1.0 * SECOND, 5);
  });

  it('test_interruption_updates_min_delay', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfAgentSpeech(100.2 * SECOND);
    expect(endpointingState(ep).agentSpeechStartedAt).toBeDefined();
    ep.onStartOfSpeech(100.25 * SECOND, true);
    expect(ep.overlapping).toBe(true);

    ep.onEndOfSpeech(100.5 * SECOND);

    expect(ep.overlapping).toBe(false);
    expect(endpointingState(ep).agentSpeechStartedAt).toBeUndefined();
    expect(ep.minDelay).toBeCloseTo(0.3 * SECOND, 5);
  });

  it('test_update_options', () => {
    let ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    ep.updateOptions({ minDelay: 0.5 * SECOND });
    expect(ep.minDelay).toBe(0.5 * SECOND);

    ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    ep.updateOptions({ maxDelay: 2.0 * SECOND });
    expect(ep.maxDelay).toBe(2.0 * SECOND);

    ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    ep.updateOptions({ minDelay: 0.5 * SECOND, maxDelay: 2.0 * SECOND });
    expect(ep.minDelay).toBe(0.5 * SECOND);
    expect(ep.maxDelay).toBe(2.0 * SECOND);

    ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });
    ep.updateOptions();
    expect(ep.minDelay).toBe(0.3 * SECOND);
    expect(ep.maxDelay).toBe(1.0 * SECOND);
  });

  it('test_max_delay_clamped_to_configured_max', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 1.0,
    });

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfAgentSpeech(102.0 * SECOND);
    ep.onStartOfSpeech(105.0 * SECOND);

    expect(ep.maxDelay).toBe(1.0 * SECOND);
  });

  it('test_max_delay_clamped_to_min_delay', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 1.0,
    });

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfAgentSpeech(100.1 * SECOND);
    ep.onStartOfSpeech(100.5 * SECOND);

    expect(ep.maxDelay).toBeGreaterThanOrEqual(0.3 * SECOND);
  });

  it('test_non_interruption_clears_agent_speech', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfAgentSpeech(100.5 * SECOND);
    expect(endpointingState(ep).agentSpeechStartedAt).toBeDefined();

    ep.onStartOfSpeech(102.0 * SECOND);
    ep.onEndOfSpeech(103.0 * SECOND, { shouldIgnore: false });
    expect(endpointingState(ep).agentSpeechStartedAt).toBeUndefined();
  });

  it('test_consecutive_interruptions_only_track_first', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfAgentSpeech(100.2 * SECOND);
    ep.onStartOfSpeech(100.25 * SECOND, true);

    expect(ep.overlapping).toBe(true);
    const prevValue = [ep.minDelay, ep.maxDelay] as const;

    ep.onStartOfSpeech(100.35 * SECOND);

    expect(ep.overlapping).toBe(true);
    expect([ep.minDelay, ep.maxDelay]).toEqual(prevValue);
  });

  it('test_delayed_interruption_updates_max_delay_without_crashing', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.onEndOfSpeech(100 * SECOND);
    ep.onStartOfAgentSpeech(100.9 * SECOND);
    ep.onStartOfSpeech(101.8 * SECOND);
    ep.onEndOfSpeech(102.0 * SECOND, { shouldIgnore: false });

    expect(ep.maxDelay).toBeCloseTo(0.5 * 0.9 * SECOND + 0.5 * 1.0 * SECOND, 5);
  });

  it('test_interruption_adjusts_stale_utterance_end_time', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.06 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 1.0,
    });

    ep.onEndOfSpeech(99.0 * SECOND);
    ep.onStartOfSpeech(100.0 * SECOND);

    ep.onStartOfAgentSpeech(100.2 * SECOND);
    ep.onStartOfSpeech(100.25 * SECOND, true);

    expect(endpointingState(ep).utteranceEndedAt).toBeCloseTo(100.199 * SECOND, 3);
    expect(ep.minDelay).toBeCloseTo(0.06 * SECOND, 5);
    expect(ep.maxDelay).toBeCloseTo(1.0 * SECOND, 5);
  });

  it('test_update_options_preserves_filter_alpha', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.updateOptions({ minDelay: 0.6 * SECOND, maxDelay: 2.0 * SECOND });

    const state = endpointingState(ep);
    expect(expFilterState(state.utterancePause).alpha).toBeCloseTo(0.5, 5);
    expect(expFilterState(state.turnPause).alpha).toBeCloseTo(0.5, 5);
  });

  it('test_update_options_updates_filter_clamp_bounds', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.updateOptions({ minDelay: 0.5 * SECOND, maxDelay: 2.0 * SECOND });
    const state = endpointingState(ep);
    expect(expFilterState(state.utterancePause).minValue).toBe(0.5 * SECOND);
    expect(expFilterState(state.turnPause).maxValue).toBe(2.0 * SECOND);

    ep.onEndOfSpeech(100.0 * SECOND);
    ep.onStartOfSpeech(100.2 * SECOND);
    expect(ep.minDelay).toBeCloseTo(0.5 * SECOND, 5);

    ep.onEndOfSpeech(101.0 * SECOND);
    ep.onStartOfAgentSpeech(102.8 * SECOND);
    ep.onStartOfSpeech(103.5 * SECOND);
    expect(ep.maxDelay).toBeGreaterThan(1.0 * SECOND);
    expect(ep.maxDelay).toBeLessThanOrEqual(2.0 * SECOND);
  });

  it('test_should_ignore_skips_filter_update', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.onEndOfSpeech(100.0 * SECOND);
    ep.onStartOfAgentSpeech(100.5 * SECOND);
    ep.onStartOfSpeech(101.5 * SECOND, true);

    const prevMin = ep.minDelay;
    const prevMax = ep.maxDelay;

    ep.onEndOfSpeech(101.8 * SECOND, { shouldIgnore: true });

    const state = endpointingState(ep);
    expect(ep.minDelay).toBe(prevMin);
    expect(ep.maxDelay).toBe(prevMax);
    expect(state.utteranceStartedAt).toBeUndefined();
    expect(state.utteranceEndedAt).toBeUndefined();
    expect(ep.overlapping).toBe(false);
    expect(state.speaking).toBe(false);
  });

  it('test_should_ignore_without_overlapping_still_updates', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100.0 * SECOND);
    ep.onStartOfSpeech(100.4 * SECOND, false);
    ep.onEndOfSpeech(100.6 * SECOND, { shouldIgnore: true });

    const expected = 0.5 * 0.4 * SECOND + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('test_should_ignore_grace_period_overrides', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.onEndOfSpeech(100.0 * SECOND);
    ep.onStartOfAgentSpeech(100.5 * SECOND);
    ep.onStartOfSpeech(100.6 * SECOND, true);

    ep.onEndOfSpeech(100.8 * SECOND, { shouldIgnore: true });

    const state = endpointingState(ep);
    expect(state.utteranceEndedAt).toBe(100.8 * SECOND);
    expect(state.speaking).toBe(false);
  });

  it('test_should_ignore_outside_grace_period', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.onEndOfSpeech(100.0 * SECOND);
    ep.onStartOfAgentSpeech(100.5 * SECOND);
    ep.onStartOfSpeech(101.0 * SECOND, true);

    const prevMin = ep.minDelay;
    const prevMax = ep.maxDelay;
    ep.onEndOfSpeech(101.5 * SECOND, { shouldIgnore: true });

    const state = endpointingState(ep);
    expect(ep.minDelay).toBe(prevMin);
    expect(ep.maxDelay).toBe(prevMax);
    expect(state.utteranceStartedAt).toBeUndefined();
    expect(state.utteranceEndedAt).toBeUndefined();
  });

  it('test_on_end_of_agent_speech_clears_state', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });

    ep.onStartOfAgentSpeech(100.0 * SECOND);
    ep.onStartOfSpeech(100.1 * SECOND, true);
    expect(ep.overlapping).toBe(true);
    expect(endpointingState(ep).agentSpeechStartedAt).toBe(100.0 * SECOND);

    ep.onEndOfAgentSpeech(101.0 * SECOND);

    const state = endpointingState(ep);
    expect(state.agentSpeechEndedAt).toBe(101.0 * SECOND);
    expect(state.agentSpeechStartedAt).toBe(100.0 * SECOND);
    expect(ep.overlapping).toBe(false);
  });

  it('test_overlapping_inferred_from_agent_speech', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.onEndOfSpeech(100.0 * SECOND);
    ep.onStartOfAgentSpeech(100.9 * SECOND);
    ep.onStartOfSpeech(101.8 * SECOND, false);
    ep.onEndOfSpeech(102.0 * SECOND);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 0.9 * SECOND + 0.5 * 1.0 * SECOND, 5);
  });

  it('test_speaking_flag_set_and_cleared', () => {
    const ep = new DynamicEndpointing({ minDelay: 0.3 * SECOND, maxDelay: 1.0 * SECOND });

    expect(endpointingState(ep).speaking).toBe(false);
    ep.onStartOfSpeech(100.0 * SECOND);
    expect(endpointingState(ep).speaking).toBe(true);

    ep.onEndOfSpeech(100.5 * SECOND);
    expect(endpointingState(ep).speaking).toBe(false);
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
    'test_all_overlapping_and_should_ignore_combos [%s]',
    (
      _label,
      agentSpeech,
      overlapping,
      shouldIgnore,
      withinGrace,
      expectMinChange,
      expectMaxChange,
    ) => {
      const ep = new DynamicEndpointing({
        minDelay: 0.3 * SECOND,
        maxDelay: 1.0 * SECOND,
        alpha: 0.5,
      });

      ep.onStartOfSpeech(99.0 * SECOND);
      ep.onEndOfSpeech(100.0 * SECOND);

      let userStart: number;
      if (agentSpeech === 'ended') {
        ep.onStartOfAgentSpeech(100.5 * SECOND);
        ep.onEndOfAgentSpeech(101.0 * SECOND);
        userStart = 101.5 * SECOND;
      } else if (agentSpeech === 'active') {
        if (withinGrace) {
          ep.onStartOfAgentSpeech(100.15 * SECOND);
          userStart = 100.35 * SECOND;
        } else if (overlapping && shouldIgnore) {
          ep.onStartOfAgentSpeech(100.2 * SECOND);
          userStart = 101.5 * SECOND;
        } else if (overlapping) {
          ep.onStartOfAgentSpeech(100.15 * SECOND);
          userStart = 100.4 * SECOND;
        } else {
          ep.onStartOfAgentSpeech(100.9 * SECOND);
          userStart = 101.8 * SECOND;
        }
      } else {
        userStart = 100.4 * SECOND;
      }

      ep.onStartOfSpeech(userStart, overlapping);

      const prevMin = ep.minDelay;
      const prevMax = ep.maxDelay;

      ep.onEndOfSpeech(userStart + 0.5 * SECOND, { shouldIgnore });

      expect(ep.minDelay !== prevMin).toBe(expectMinChange);
      expect(ep.maxDelay !== prevMax).toBe(expectMaxChange);
      expect(endpointingState(ep).speaking).toBe(false);
      expect(ep.overlapping).toBe(false);
    },
  );

  it('test_full_conversation_sequence', () => {
    const ep = new DynamicEndpointing({
      minDelay: 0.3 * SECOND,
      maxDelay: 1.0 * SECOND,
      alpha: 0.5,
    });

    ep.onStartOfSpeech(100.0 * SECOND);
    ep.onEndOfSpeech(101.0 * SECOND);

    ep.onStartOfAgentSpeech(101.5 * SECOND);

    ep.onStartOfSpeech(102.5 * SECOND, true);
    const minBeforeBackchannel = ep.minDelay;
    const maxBeforeBackchannel = ep.maxDelay;
    ep.onEndOfSpeech(102.8 * SECOND, { shouldIgnore: true });

    expect(ep.minDelay).toBe(minBeforeBackchannel);
    expect(ep.maxDelay).toBe(maxBeforeBackchannel);

    ep.onEndOfAgentSpeech(103.0 * SECOND);

    ep.onStartOfSpeech(103.5 * SECOND);
    ep.onEndOfSpeech(104.0 * SECOND);

    expect(endpointingState(ep).speaking).toBe(false);
    expect(endpointingState(ep).agentSpeechStartedAt).toBeUndefined();
  });
});
