// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import { ExpFilter } from '../../utils.js';
import { DynamicEndpointing } from './endpointing.js';

const ms = (seconds: number) => seconds * 1000;

type DynamicEndpointingState = {
  configuredMinDelay: number;
  configuredMaxDelay: number;
  overlappingValue: boolean;
  utterancePause: ExpFilter;
  turnPause: ExpFilter;
  utteranceStartedAt?: number;
  utteranceEndedAt?: number;
  agentSpeechStartedAt?: number;
  agentSpeechEndedAt?: number;
  speaking: boolean;
};

function state(ep: DynamicEndpointing): DynamicEndpointingState {
  return ep as unknown as DynamicEndpointingState;
}

// Ref: python tests/test_endpointing.py - 7-62 lines
describe('ExpFilter', () => {
  it('test_initialization_with_valid_alpha', () => {
    const ema = new ExpFilter(0.5);
    expect(ema.value).toBeUndefined();

    const emaWithInitial = new ExpFilter(0.5, { initial: 10 });
    expect(emaWithInitial.value).toBe(10);

    const emaAlphaOne = new ExpFilter(1.0);
    expect(emaAlphaOne.value).toBeUndefined();
  });

  it('test_initialization_with_invalid_alpha', () => {
    expect(() => new ExpFilter(0.0)).toThrow(/alpha must be in/);
    expect(() => new ExpFilter(-0.5)).toThrow(/alpha must be in/);
    expect(() => new ExpFilter(1.5)).toThrow(/alpha must be in/);
  });

  it('test_update_with_no_initial_value', () => {
    const ema = new ExpFilter(0.5);
    const result = ema.apply(1, 10);
    expect(result).toBe(10);
    expect(ema.value).toBe(10);
  });

  it('test_update_with_initial_value', () => {
    const ema = new ExpFilter(0.5, { initial: 10 });
    const result = ema.apply(1, 20);
    expect(result).toBe(15);
    expect(ema.value).toBe(15);
  });

  it('test_update_multiple_times', () => {
    const ema = new ExpFilter(0.5, { initial: 10 });
    ema.apply(1, 20);
    ema.apply(1, 20);
    expect(ema.value).toBe(17.5);
  });

  it('test_reset', () => {
    let ema = new ExpFilter(0.5, { initial: 10 });
    expect(ema.value).toBe(10);
    ema.reset();
    expect(ema.value).toBe(10);

    ema = new ExpFilter(0.5, { initial: 10 });
    ema.reset({ initial: 5 });
    expect(ema.value).toBe(5);
  });
});

// Ref: python tests/test_endpointing.py - 64-545 lines
describe('DynamicEndpointing', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('test_initialization', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    expect(ep.minDelay).toBe(ms(0.3));
    expect(ep.maxDelay).toBe(ms(1.0));
  });

  it('test_initialization_with_custom_alpha', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.2);
    expect(ep.minDelay).toBe(ms(0.3));
    expect(ep.maxDelay).toBe(ms(1.0));
  });

  it('test_initialization_uses_updated_default_alpha', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    expect(state(ep).utterancePause.alpha).toBeCloseTo(0.9, 5);
    expect(state(ep).turnPause.alpha).toBeCloseTo(0.9, 5);
  });

  it('test_empty_delays', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    expect(ep.betweenUtteranceDelay).toBe(0);
    expect(ep.betweenTurnDelay).toBe(0);
    expect(ep.immediateInterruptionDelay).toEqual([0, 0]);
  });

  it('test_on_utterance_ended', () => {
    let ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.onEndOfSpeech(ms(100.0));
    expect(state(ep).utteranceEndedAt).toBe(ms(100.0));

    ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.onEndOfSpeech(ms(99.9));
    expect(state(ep).utteranceEndedAt).toBe(ms(99.9));
  });

  it('test_on_utterance_started', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.onStartOfSpeech(ms(100.0));
    expect(state(ep).utteranceStartedAt).toBe(ms(100.0));
  });

  it('test_on_agent_speech_started', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.onStartOfAgentSpeech(ms(100.0));
    expect(state(ep).agentSpeechStartedAt).toBe(ms(100.0));
  });

  it('test_between_utterance_delay_calculation', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfSpeech(ms(100.5));
    expect(ep.betweenUtteranceDelay).toBeCloseTo(ms(0.5), 5);
  });

  it('test_between_turn_delay_calculation', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.8));
    expect(ep.betweenTurnDelay).toBeCloseTo(ms(0.8), 5);
  });

  it('test_pause_between_utterances_updates_min_delay', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    const initialMin = ep.minDelay;
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfSpeech(ms(100.4));
    ep.onEndOfSpeech(ms(100.5), false);
    const expected = 0.5 * ms(0.4) + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('test_new_turn_updates_max_delay', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.6));
    ep.onStartOfSpeech(ms(101.5));
    ep.onEndOfSpeech(ms(102.0), false);
    expect(ep.maxDelay).toBeCloseTo(0.5 * ms(0.6) + 0.5 * ms(1.0), 5);
  });

  it('test_interruption_updates_min_delay', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.2));
    expect(state(ep).agentSpeechStartedAt).toBeDefined();
    ep.onStartOfSpeech(ms(100.25), true);
    expect(ep.overlapping).toBe(true);
    ep.onEndOfSpeech(ms(100.5));
    expect(ep.overlapping).toBe(false);
    expect(state(ep).agentSpeechStartedAt).toBeUndefined();
    expect(ep.minDelay).toBeCloseTo(ms(0.3), 5);
  });

  it('test_update_options', () => {
    let ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.updateOptions({ minDelay: ms(0.5) });
    expect(ep.minDelay).toBe(ms(0.5));
    expect(state(ep).configuredMinDelay).toBe(ms(0.5));

    ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.updateOptions({ maxDelay: ms(2.0) });
    expect(ep.maxDelay).toBe(ms(2.0));
    expect(state(ep).configuredMaxDelay).toBe(ms(2.0));

    ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.updateOptions({ minDelay: ms(0.5), maxDelay: ms(2.0) });
    expect(ep.minDelay).toBe(ms(0.5));
    expect(ep.maxDelay).toBe(ms(2.0));

    ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.updateOptions();
    expect(ep.minDelay).toBe(ms(0.3));
    expect(ep.maxDelay).toBe(ms(1.0));
  });

  it('test_max_delay_clamped_to_configured_max', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 1.0);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(102.0));
    ep.onStartOfSpeech(ms(105.0));
    expect(ep.maxDelay).toBe(ms(1.0));
  });

  it('test_max_delay_clamped_to_min_delay', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 1.0);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.1));
    ep.onStartOfSpeech(ms(100.5));
    expect(ep.maxDelay).toBeGreaterThanOrEqual(state(ep).configuredMinDelay);
  });

  it('test_non_interruption_clears_agent_speech', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.5));
    expect(state(ep).agentSpeechStartedAt).toBeDefined();
    ep.onStartOfSpeech(ms(102.0));
    ep.onEndOfSpeech(ms(103.0), false);
    expect(state(ep).agentSpeechStartedAt).toBeUndefined();
  });

  it('test_consecutive_interruptions_only_track_first', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.2));
    ep.onStartOfSpeech(ms(100.25), true);
    expect(ep.overlapping).toBe(true);
    const prevVal = [ep.minDelay, ep.maxDelay];
    ep.onStartOfSpeech(ms(100.35));
    expect(ep.overlapping).toBe(true);
    expect(prevVal).toEqual([ep.minDelay, ep.maxDelay]);
  });

  it('test_delayed_interruption_updates_max_delay_without_crashing', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.9));
    ep.onStartOfSpeech(ms(101.8));
    ep.onEndOfSpeech(ms(102.0), false);
    expect(ep.maxDelay).toBeCloseTo(0.5 * ms(0.9) + 0.5 * ms(1.0), 5);
  });

  it('test_interruption_adjusts_stale_utterance_end_time', () => {
    const ep = new DynamicEndpointing(ms(0.06), ms(1.0), 1.0);
    ep.onEndOfSpeech(ms(99.0));
    ep.onStartOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.2));
    ep.onStartOfSpeech(ms(100.25), true);
    expect(state(ep).utteranceEndedAt).toBeCloseTo(ms(100.2) - 1, 5);
    expect(ep.minDelay).toBeCloseTo(ms(0.06), 5);
    expect(ep.maxDelay).toBeCloseTo(ms(1.0), 5);
  });

  it('test_update_options_preserves_filter_alpha', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.updateOptions({ minDelay: ms(0.6), maxDelay: ms(2.0) });
    expect(state(ep).utterancePause.alpha).toBeCloseTo(0.5, 5);
    expect(state(ep).turnPause.alpha).toBeCloseTo(0.5, 5);
  });

  it('test_update_options_updates_filter_clamp_bounds', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.updateOptions({ minDelay: ms(0.5), maxDelay: ms(2.0) });
    expect(state(ep).utterancePause.minVal).toBe(ms(0.5));
    expect(state(ep).turnPause.maxVal).toBe(ms(2.0));

    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfSpeech(ms(100.2));
    expect(ep.minDelay).toBeCloseTo(ms(0.5), 5);

    ep.onEndOfSpeech(ms(101.0));
    ep.onStartOfAgentSpeech(ms(102.8));
    ep.onStartOfSpeech(ms(103.5));
    expect(ep.maxDelay).toBeGreaterThan(ms(1.0));
    expect(ep.maxDelay).toBeLessThanOrEqual(ms(2.0));
  });

  it('test_should_ignore_skips_filter_update', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.5));
    ep.onStartOfSpeech(ms(101.5), true);
    const prevMin = ep.minDelay;
    const prevMax = ep.maxDelay;
    ep.onEndOfSpeech(ms(101.8), true);
    expect(ep.minDelay).toBe(prevMin);
    expect(ep.maxDelay).toBe(prevMax);
    expect(state(ep).utteranceStartedAt).toBeUndefined();
    expect(state(ep).utteranceEndedAt).toBeUndefined();
    expect(ep.overlapping).toBe(false);
    expect(state(ep).speaking).toBe(false);
  });

  it('test_should_ignore_without_overlapping_still_updates', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    const initialMin = ep.minDelay;
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfSpeech(ms(100.4), false);
    ep.onEndOfSpeech(ms(100.6), true);
    const expected = 0.5 * ms(0.4) + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  it('test_should_ignore_grace_period_overrides', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.5));
    ep.onStartOfSpeech(ms(100.6), true);
    ep.onEndOfSpeech(ms(100.8), true);
    expect(state(ep).utteranceEndedAt).toBe(ms(100.8));
    expect(state(ep).speaking).toBe(false);
  });

  it('test_should_ignore_outside_grace_period', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.5));
    ep.onStartOfSpeech(ms(101.0), true);
    const prevMin = ep.minDelay;
    const prevMax = ep.maxDelay;
    ep.onEndOfSpeech(ms(101.5), true);
    expect(ep.minDelay).toBe(prevMin);
    expect(ep.maxDelay).toBe(prevMax);
    expect(state(ep).utteranceStartedAt).toBeUndefined();
    expect(state(ep).utteranceEndedAt).toBeUndefined();
  });

  it('test_on_end_of_agent_speech_clears_state', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    ep.onStartOfAgentSpeech(ms(100.0));
    ep.onStartOfSpeech(ms(100.1), true);
    expect(ep.overlapping).toBe(true);
    expect(state(ep).agentSpeechStartedAt).toBe(ms(100.0));
    ep.onEndOfAgentSpeech(ms(101.0));
    expect(state(ep).agentSpeechEndedAt).toBe(ms(101.0));
    expect(state(ep).agentSpeechStartedAt).toBe(ms(100.0));
    expect(ep.overlapping).toBe(false);
  });

  it('test_overlapping_inferred_from_agent_speech', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.onEndOfSpeech(ms(100.0));
    ep.onStartOfAgentSpeech(ms(100.9));
    ep.onStartOfSpeech(ms(101.8), false);
    ep.onEndOfSpeech(ms(102.0));
    expect(ep.maxDelay).toBeCloseTo(0.5 * ms(0.9) + 0.5 * ms(1.0), 5);
  });

  it('test_speaking_flag_set_and_cleared', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0));
    expect(state(ep).speaking).toBe(false);
    ep.onStartOfSpeech(ms(100.0));
    expect(state(ep).speaking).toBe(true);
    ep.onEndOfSpeech(ms(100.5));
    expect(state(ep).speaking).toBe(false);
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
    'test_all_overlapping_and_should_ignore_combos %s',
    (
      label,
      agentSpeech,
      overlapping,
      shouldIgnore,
      withinGrace,
      expectMinChange,
      expectMaxChange,
    ) => {
      const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
      ep.onStartOfSpeech(ms(99.0));
      ep.onEndOfSpeech(ms(100.0));

      let userStart: number;
      if (agentSpeech === 'ended') {
        ep.onStartOfAgentSpeech(ms(100.5));
        ep.onEndOfAgentSpeech(ms(101.0));
        userStart = ms(101.5);
      } else if (agentSpeech === 'active') {
        if (withinGrace) {
          ep.onStartOfAgentSpeech(ms(100.15));
          userStart = ms(100.35);
        } else if (overlapping && shouldIgnore) {
          ep.onStartOfAgentSpeech(ms(100.2));
          userStart = ms(101.5);
        } else if (overlapping) {
          ep.onStartOfAgentSpeech(ms(100.15));
          userStart = ms(100.4);
        } else {
          ep.onStartOfAgentSpeech(ms(100.9));
          userStart = ms(101.8);
        }
      } else {
        userStart = ms(100.4);
      }

      ep.onStartOfSpeech(userStart, overlapping);
      const prevMin = ep.minDelay;
      const prevMax = ep.maxDelay;
      ep.onEndOfSpeech(userStart + ms(0.5), shouldIgnore);
      const minChanged = ep.minDelay !== prevMin;
      const maxChanged = ep.maxDelay !== prevMax;

      expect(minChanged, `[${label}] min_delay change`).toBe(expectMinChange);
      expect(maxChanged, `[${label}] max_delay change`).toBe(expectMaxChange);
      expect(state(ep).speaking, `[${label}] speaking`).toBe(false);
      expect(ep.overlapping, `[${label}] overlapping`).toBe(false);
    },
  );

  it('test_full_conversation_sequence', () => {
    const ep = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    ep.onStartOfSpeech(ms(100.0));
    ep.onEndOfSpeech(ms(101.0));

    ep.onStartOfAgentSpeech(ms(101.5));
    ep.onStartOfSpeech(ms(102.5), true);
    const minBeforeBackchannel = ep.minDelay;
    const maxBeforeBackchannel = ep.maxDelay;
    ep.onEndOfSpeech(ms(102.8), true);

    expect(ep.minDelay).toBe(minBeforeBackchannel);
    expect(ep.maxDelay).toBe(maxBeforeBackchannel);

    ep.onEndOfAgentSpeech(ms(103.0));
    ep.onStartOfSpeech(ms(103.5));
    ep.onEndOfSpeech(ms(104.0));

    expect(state(ep).speaking).toBe(false);
    expect(state(ep).agentSpeechStartedAt).toBeUndefined();
  });
});
