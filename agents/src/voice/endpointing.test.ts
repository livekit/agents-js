// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { ExpFilter } from '../utils.js';
import { DynamicEndpointing } from './endpointing.js';

initializeLogger({ pretty: false, level: 'silent' });

type DynamicEndpointingInternals = {
  utterancePause: ExpFilter;
  turnPause: ExpFilter;
  utteranceStartedAt?: number;
  utteranceEndedAt?: number;
  agentSpeechStartedAt?: number;
  agentSpeechEndedAt?: number;
  speaking: boolean;
  configuredMinDelay: number;
  configuredMaxDelay: number;
};

function internals(ep: DynamicEndpointing): DynamicEndpointingInternals {
  return ep as unknown as DynamicEndpointingInternals;
}

// Ref: python tests/test_endpointing.py - 7-63 lines
describe('ExponentialMovingAverage', () => {
  it('test_initialization_with_valid_alpha', () => {
    const ema = new ExpFilter(0.5);
    expect(ema.value).toBeUndefined();

    const emaWithInitial = new ExpFilter(0.5, undefined, undefined, 10);
    expect(emaWithInitial.value).toBe(10);

    expect(new ExpFilter(1.0).value).toBeUndefined();
  });

  it('test_initialization_with_invalid_alpha', () => {
    expect(() => new ExpFilter(0.0)).toThrow(/alpha must be in/);
    expect(() => new ExpFilter(-0.5)).toThrow(/alpha must be in/);
    expect(() => new ExpFilter(1.5)).toThrow(/alpha must be in/);
  });

  it('test_update_with_no_initial_value', () => {
    const ema = new ExpFilter(0.5);
    const result = ema.apply(1.0, 10.0);
    expect(result).toBe(10.0);
    expect(ema.value).toBe(10.0);
  });

  it('test_update_with_initial_value', () => {
    const ema = new ExpFilter(0.5, undefined, undefined, 10.0);
    const result = ema.apply(1.0, 20.0);
    expect(result).toBe(15.0);
    expect(ema.value).toBe(15.0);
  });

  it('test_update_multiple_times', () => {
    const ema = new ExpFilter(0.5, undefined, undefined, 10.0);
    ema.apply(1.0, 20.0);
    ema.apply(1.0, 20.0);
    expect(ema.value).toBe(17.5);
  });

  it('test_reset', () => {
    const ema = new ExpFilter(0.5, undefined, undefined, 10.0);
    expect(ema.value).toBe(10.0);
    ema.reset();
    expect(ema.value).toBe(10.0);

    const emaWithReset = new ExpFilter(0.5, undefined, undefined, 10.0);
    emaWithReset.reset({ initialValue: 5.0 });
    expect(emaWithReset.value).toBe(5.0);
  });
});

// Ref: python tests/test_endpointing.py - 64-545 lines
describe('DynamicEndpointing', () => {
  it('test_initialization', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  it('test_initialization_with_custom_alpha', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.2);
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  it('test_initialization_uses_updated_default_alpha', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect(internals(ep).utterancePause.alpha).toBeCloseTo(0.9, 5);
    expect(internals(ep).turnPause.alpha).toBeCloseTo(0.9, 5);
  });

  it('test_empty_delays', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect(ep.betweenUtteranceDelay).toBe(0);
    expect(ep.betweenTurnDelay).toBe(0);
    expect(ep.immediateInterruptionDelay).toEqual([0, 0]);
  });

  it('test_on_utterance_ended', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100_000);
    expect(internals(ep).utteranceEndedAt).toBe(100_000);

    const second = new DynamicEndpointing(300, 1000);
    second.onEndOfSpeech(99_900);
    expect(internals(second).utteranceEndedAt).toBe(99_900);
  });

  it('test_on_utterance_started', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfSpeech(100_000);
    expect(internals(ep).utteranceStartedAt).toBe(100_000);
  });

  it('test_on_agent_speech_started', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfAgentSpeech(100_000);
    expect(internals(ep).agentSpeechStartedAt).toBe(100_000);
  });

  it('test_between_utterance_delay_calculation', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100_000);
    ep.onStartOfSpeech(100_500);
    expect(ep.betweenUtteranceDelay).toBeCloseTo(500, 5);
  });

  it('test_between_turn_delay_calculation', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_800);
    expect(ep.betweenTurnDelay).toBeCloseTo(800, 5);
  });

  it('test_pause_between_utterances_updates_min_delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100_000);
    ep.onStartOfSpeech(100_400);
    ep.onEndOfSpeech(100_500, false);

    const expected = 0.5 * 400 + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('test_new_turn_updates_max_delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_600);
    ep.onStartOfSpeech(101_500);
    ep.onEndOfSpeech(102_000, false);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 600 + 0.5 * 1000, 5);
  });

  it('test_interruption_updates_min_delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_200);
    expect(internals(ep).agentSpeechStartedAt).toBeDefined();
    ep.onStartOfSpeech(100_250, true);
    expect(ep.overlapping).toBe(true);

    ep.onEndOfSpeech(100_500);

    expect(ep.overlapping).toBe(false);
    expect(internals(ep).agentSpeechStartedAt).toBeUndefined();
    expect(ep.minDelay).toBeCloseTo(300, 5);
  });

  it('test_update_options', () => {
    const minEp = new DynamicEndpointing(300, 1000);
    minEp.updateOptions({ minDelay: 500 });
    expect(minEp.minDelay).toBe(500);
    expect(internals(minEp).configuredMinDelay).toBe(500);

    const maxEp = new DynamicEndpointing(300, 1000);
    maxEp.updateOptions({ maxDelay: 2000 });
    expect(maxEp.maxDelay).toBe(2000);
    expect(internals(maxEp).configuredMaxDelay).toBe(2000);

    const both = new DynamicEndpointing(300, 1000);
    both.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect(both.minDelay).toBe(500);
    expect(both.maxDelay).toBe(2000);

    const unchanged = new DynamicEndpointing(300, 1000);
    unchanged.updateOptions();
    expect(unchanged.minDelay).toBe(300);
    expect(unchanged.maxDelay).toBe(1000);
  });

  it('test_max_delay_clamped_to_configured_max', () => {
    const ep = new DynamicEndpointing(300, 1000, 1.0);
    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(102_000);
    ep.onStartOfSpeech(105_000);
    expect(ep.maxDelay).toBe(1000);
  });

  it('test_max_delay_clamped_to_min_delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 1.0);
    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_100);
    ep.onStartOfSpeech(100_500);
    expect(ep.maxDelay).toBeGreaterThanOrEqual(internals(ep).configuredMinDelay);
  });

  it('test_non_interruption_clears_agent_speech', () => {
    const ep = new DynamicEndpointing(300, 1000);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_500);
    expect(internals(ep).agentSpeechStartedAt).toBeDefined();

    ep.onStartOfSpeech(102_000);
    ep.onEndOfSpeech(103_000, false);
    expect(internals(ep).agentSpeechStartedAt).toBeUndefined();
  });

  it('test_consecutive_interruptions_only_track_first', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_200);
    ep.onStartOfSpeech(100_250, true);

    expect(ep.overlapping).toBe(true);
    const previous = [ep.minDelay, ep.maxDelay];

    ep.onStartOfSpeech(100_350);

    expect(ep.overlapping).toBe(true);
    expect([ep.minDelay, ep.maxDelay]).toEqual(previous);
  });

  it('test_delayed_interruption_updates_max_delay_without_crashing', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_900);
    ep.onStartOfSpeech(101_800);
    ep.onEndOfSpeech(102_000, false);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 900 + 0.5 * 1000, 5);
  });

  it('test_interruption_adjusts_stale_utterance_end_time', () => {
    const ep = new DynamicEndpointing(60, 1000, 1.0);

    ep.onEndOfSpeech(99_000);
    ep.onStartOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_200);
    ep.onStartOfSpeech(100_250, true);

    expect(internals(ep).utteranceEndedAt).toBe(100_199);
    expect(ep.minDelay).toBeCloseTo(60, 5);
    expect(ep.maxDelay).toBeCloseTo(1000, 5);
  });

  it('test_update_options_preserves_filter_alpha', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.updateOptions({ minDelay: 600, maxDelay: 2000 });
    expect(internals(ep).utterancePause.alpha).toBeCloseTo(0.5, 5);
    expect(internals(ep).turnPause.alpha).toBeCloseTo(0.5, 5);
  });

  it('test_update_options_updates_filter_clamp_bounds', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect(internals(ep).utterancePause.minValue).toBe(500);
    expect(internals(ep).turnPause.maxValue).toBe(2000);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfSpeech(100_200);
    expect(ep.minDelay).toBeCloseTo(500, 5);

    ep.onEndOfSpeech(101_000);
    ep.onStartOfAgentSpeech(102_800);
    ep.onStartOfSpeech(103_500);
    expect(ep.maxDelay).toBeGreaterThan(1000);
    expect(ep.maxDelay).toBeLessThanOrEqual(2000);
  });

  it('test_should_ignore_skips_filter_update', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_500);
    ep.onStartOfSpeech(101_500, true);

    const previousMin = ep.minDelay;
    const previousMax = ep.maxDelay;

    ep.onEndOfSpeech(101_800, true);

    expect(ep.minDelay).toBe(previousMin);
    expect(ep.maxDelay).toBe(previousMax);
    expect(internals(ep).utteranceStartedAt).toBeUndefined();
    expect(internals(ep).utteranceEndedAt).toBeUndefined();
    expect(ep.overlapping).toBe(false);
    expect(internals(ep).speaking).toBe(false);
  });

  it('test_should_ignore_without_overlapping_still_updates', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100_000);
    ep.onStartOfSpeech(100_400, false);
    ep.onEndOfSpeech(100_600, true);

    const expected = 0.5 * 400 + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('test_should_ignore_grace_period_overrides', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_500);
    ep.onStartOfSpeech(100_600, true);

    ep.onEndOfSpeech(100_800, true);

    expect(internals(ep).utteranceEndedAt).toBe(100_800);
    expect(internals(ep).speaking).toBe(false);
  });

  it('test_should_ignore_outside_grace_period', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_500);
    ep.onStartOfSpeech(101_000, true);

    const previousMin = ep.minDelay;
    const previousMax = ep.maxDelay;
    ep.onEndOfSpeech(101_500, true);

    expect(ep.minDelay).toBe(previousMin);
    expect(ep.maxDelay).toBe(previousMax);
    expect(internals(ep).utteranceStartedAt).toBeUndefined();
    expect(internals(ep).utteranceEndedAt).toBeUndefined();
  });

  it('test_on_end_of_agent_speech_clears_state', () => {
    const ep = new DynamicEndpointing(300, 1000);

    ep.onStartOfAgentSpeech(100_000);
    ep.onStartOfSpeech(100_100, true);
    expect(ep.overlapping).toBe(true);
    expect(internals(ep).agentSpeechStartedAt).toBe(100_000);

    ep.onEndOfAgentSpeech(101_000);

    expect(internals(ep).agentSpeechEndedAt).toBe(101_000);
    expect(internals(ep).agentSpeechStartedAt).toBe(100_000);
    expect(ep.overlapping).toBe(false);
  });

  it('test_overlapping_inferred_from_agent_speech', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_900);
    ep.onStartOfSpeech(101_800, false);
    ep.onEndOfSpeech(102_000);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 900 + 0.5 * 1000, 5);
  });

  it('test_speaking_flag_set_and_cleared', () => {
    const ep = new DynamicEndpointing(300, 1000);

    expect(internals(ep).speaking).toBe(false);
    ep.onStartOfSpeech(100_000);
    expect(internals(ep).speaking).toBe(true);
    ep.onEndOfSpeech(100_500);
    expect(internals(ep).speaking).toBe(false);
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
  ] as const)(
    'test_all_overlapping_and_should_ignore_combos[%s]',
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

      ep.onStartOfSpeech(99_000);
      ep.onEndOfSpeech(100_000);

      let userStart = 100_400;
      if (agentSpeech === 'ended') {
        ep.onStartOfAgentSpeech(100_500);
        ep.onEndOfAgentSpeech(101_000);
        userStart = 101_500;
      } else if (agentSpeech === 'active') {
        if (withinGrace) {
          ep.onStartOfAgentSpeech(100_150);
          userStart = 100_350;
        } else if (overlapping && shouldIgnore) {
          ep.onStartOfAgentSpeech(100_200);
          userStart = 101_500;
        } else if (overlapping) {
          ep.onStartOfAgentSpeech(100_150);
          userStart = 100_400;
        } else {
          ep.onStartOfAgentSpeech(100_900);
          userStart = 101_800;
        }
      }

      ep.onStartOfSpeech(userStart, overlapping);

      const previousMin = ep.minDelay;
      const previousMax = ep.maxDelay;

      ep.onEndOfSpeech(userStart + 500, shouldIgnore);

      expect(ep.minDelay !== previousMin, `[${label}] minDelay change mismatch`).toBe(
        expectMinChange,
      );
      expect(ep.maxDelay !== previousMax, `[${label}] maxDelay change mismatch`).toBe(
        expectMaxChange,
      );
      expect(internals(ep).speaking, `[${label}] speaking should be false`).toBe(false);
      expect(ep.overlapping, `[${label}] overlapping should be false`).toBe(false);
    },
  );

  it('test_full_conversation_sequence', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onStartOfSpeech(100_000);
    ep.onEndOfSpeech(101_000);

    ep.onStartOfAgentSpeech(101_500);

    ep.onStartOfSpeech(102_500, true);
    const minBeforeBackchannel = ep.minDelay;
    const maxBeforeBackchannel = ep.maxDelay;
    ep.onEndOfSpeech(102_800, true);

    expect(ep.minDelay).toBe(minBeforeBackchannel);
    expect(ep.maxDelay).toBe(maxBeforeBackchannel);

    ep.onEndOfAgentSpeech(103_000);
    ep.onStartOfSpeech(103_500);
    ep.onEndOfSpeech(104_000);

    expect(internals(ep).speaking).toBe(false);
    expect(internals(ep).agentSpeechStartedAt).toBeUndefined();
  });
});
