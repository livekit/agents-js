// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { ExpFilter } from '../utils.js';
import { DynamicEndpointing } from './endpointing.js';

const toMs = (seconds: number) => seconds * 1000;

function expectClose(actual: number, expected: number) {
  expect(actual).toBeCloseTo(expected, 5);
}

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

// Ref: python tests/test_endpointing.py - 7-63 lines
describe('ExpFilter', () => {
  it('test_initialization_with_valid_alpha', () => {
    const ema = new ExpFilter(0.5);
    expect(ema.value).toBeUndefined();

    const emaWithInitial = new ExpFilter(0.5, { initial: 10 });
    expect(emaWithInitial.value).toBe(10);

    const emaWithOne = new ExpFilter(1.0);
    expect(emaWithOne.value).toBeUndefined();
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
describe('DynamicEndpointing', () => {
  it('test_initialization', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    expect(ep.minDelay).toBe(toMs(0.3));
    expect(ep.maxDelay).toBe(toMs(1.0));
  });

  it('test_initialization_with_custom_alpha', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.2);
    expect(ep.minDelay).toBe(toMs(0.3));
    expect(ep.maxDelay).toBe(toMs(1.0));
  });

  it('test_initialization_uses_updated_default_alpha', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    expectClose((ep as any).utterancePause.alpha, 0.9);
    expectClose((ep as any).turnPause.alpha, 0.9);
  });

  it('test_empty_delays', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    expect(ep.betweenUtteranceDelay).toBe(0);
    expect(ep.betweenTurnDelay).toBe(0);
    expect(ep.immediateInterruptionDelay).toEqual([0, 0]);
  });

  it('test_on_utterance_ended', () => {
    let ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.onEndOfSpeech(100_000);
    expect((ep as any).utteranceEndedAt).toBe(100_000);

    ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.onEndOfSpeech(99_900);
    expect((ep as any).utteranceEndedAt).toBe(99_900);
  });

  it('test_on_utterance_started', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.onStartOfSpeech(100_000);
    expect((ep as any).utteranceStartedAt).toBe(100_000);
  });

  it('test_on_agent_speech_started', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.onStartOfAgentSpeech(100_000);
    expect((ep as any).agentSpeechStartedAt).toBe(100_000);
  });

  it('test_between_utterance_delay_calculation', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.onEndOfSpeech(100_000);
    ep.onStartOfSpeech(100_500);
    expectClose(ep.betweenUtteranceDelay, 500);
  });

  it('test_between_turn_delay_calculation', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_800);
    expectClose(ep.betweenTurnDelay, 800);
  });

  it('test_pause_between_utterances_updates_min_delay', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100_000);
    ep.onStartOfSpeech(100_400);
    ep.onEndOfSpeech(100_500, false);

    const expected = 0.5 * 400 + 0.5 * initialMin;
    expectClose(ep.minDelay, expected);
  });

  it('test_new_turn_updates_max_delay', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_600);
    ep.onStartOfSpeech(101_500);
    ep.onEndOfSpeech(102_000, false);

    expectClose(ep.maxDelay, 0.5 * 600 + 0.5 * 1000);
  });

  it('test_interruption_updates_min_delay', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_200);
    expect((ep as any).agentSpeechStartedAt).toBeDefined();
    ep.onStartOfSpeech(100_250, true);
    expect((ep as any).overlappingState).toBe(true);

    ep.onEndOfSpeech(100_500);

    expect((ep as any).overlappingState).toBe(false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
    expectClose(ep.minDelay, 300);
  });

  it('test_update_options', () => {
    let ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.updateOptions({ minDelay: toMs(0.5) });
    expect(ep.minDelay).toBe(toMs(0.5));
    expect((ep as any).configuredMinDelay).toBe(toMs(0.5));

    ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.updateOptions({ maxDelay: toMs(2.0) });
    expect(ep.maxDelay).toBe(toMs(2.0));
    expect((ep as any).configuredMaxDelay).toBe(toMs(2.0));

    ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.updateOptions({ minDelay: toMs(0.5), maxDelay: toMs(2.0) });
    expect(ep.minDelay).toBe(toMs(0.5));
    expect(ep.maxDelay).toBe(toMs(2.0));

    ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));
    ep.updateOptions();
    expect(ep.minDelay).toBe(toMs(0.3));
    expect(ep.maxDelay).toBe(toMs(1.0));
  });

  it('test_max_delay_clamped_to_configured_max', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 1.0);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(102_000);
    ep.onStartOfSpeech(105_000);

    expect(ep.maxDelay).toBe(1000);
  });

  it('test_max_delay_clamped_to_min_delay', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 1.0);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_100);
    ep.onStartOfSpeech(100_500);

    expect(ep.maxDelay).toBeGreaterThanOrEqual((ep as any).configuredMinDelay);
  });

  it('test_non_interruption_clears_agent_speech', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_500);
    expect((ep as any).agentSpeechStartedAt).toBeDefined();

    ep.onStartOfSpeech(102_000);
    ep.onEndOfSpeech(103_000, false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
  });

  it('test_consecutive_interruptions_only_track_first', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_200);
    ep.onStartOfSpeech(100_250, true);

    expect((ep as any).overlappingState).toBe(true);
    const previous = [ep.minDelay, ep.maxDelay];

    ep.onStartOfSpeech(100_350);

    expect((ep as any).overlappingState).toBe(true);
    expect([ep.minDelay, ep.maxDelay]).toEqual(previous);
  });

  it('test_delayed_interruption_updates_max_delay_without_crashing', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_900);
    ep.onStartOfSpeech(101_800);
    ep.onEndOfSpeech(102_000, false);

    expectClose(ep.maxDelay, 0.5 * 900 + 0.5 * 1000);
  });

  it('test_interruption_adjusts_stale_utterance_end_time', () => {
    const ep = new DynamicEndpointing(toMs(0.06), toMs(1.0), 1.0);

    ep.onEndOfSpeech(99_000);
    ep.onStartOfSpeech(100_000);

    ep.onStartOfAgentSpeech(100_200);
    ep.onStartOfSpeech(100_250, true);

    expectClose((ep as any).utteranceEndedAt, 100_199);
    expectClose(ep.minDelay, 60);
    expectClose(ep.maxDelay, 1000);
  });

  it('test_update_options_preserves_filter_alpha', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.updateOptions({ minDelay: toMs(0.6), maxDelay: toMs(2.0) });

    expectClose((ep as any).utterancePause.alpha, 0.5);
    expectClose((ep as any).turnPause.alpha, 0.5);
  });

  it('test_update_options_updates_filter_clamp_bounds', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.updateOptions({ minDelay: toMs(0.5), maxDelay: toMs(2.0) });
    expect((ep as any).utterancePause.min).toBe(500);
    expect((ep as any).turnPause.max).toBe(2000);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfSpeech(100_200);
    expectClose(ep.minDelay, 500);

    ep.onEndOfSpeech(101_000);
    ep.onStartOfAgentSpeech(102_800);
    ep.onStartOfSpeech(103_500);
    expect(ep.maxDelay).toBeGreaterThan(1000);
    expect(ep.maxDelay).toBeLessThanOrEqual(2000);
  });

  it('test_should_ignore_skips_filter_update', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_500);
    ep.onStartOfSpeech(101_500, true);

    const previousMin = ep.minDelay;
    const previousMax = ep.maxDelay;

    ep.onEndOfSpeech(101_800, true);

    expect(ep.minDelay).toBe(previousMin);
    expect(ep.maxDelay).toBe(previousMax);
    expect((ep as any).utteranceStartedAt).toBeUndefined();
    expect((ep as any).utteranceEndedAt).toBeUndefined();
    expect((ep as any).overlappingState).toBe(false);
    expect((ep as any).speaking).toBe(false);
  });

  it('test_should_ignore_without_overlapping_still_updates', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100_000);
    ep.onStartOfSpeech(100_400, false);
    ep.onEndOfSpeech(100_600, true);

    const expected = 0.5 * 400 + 0.5 * initialMin;
    expectClose(ep.minDelay, expected);
  });

  it('test_should_ignore_grace_period_overrides', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_500);
    ep.onStartOfSpeech(100_600, true);

    ep.onEndOfSpeech(100_800, true);

    expect((ep as any).utteranceEndedAt).toBe(100_800);
    expect((ep as any).speaking).toBe(false);
  });

  it('test_should_ignore_outside_grace_period', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_500);
    ep.onStartOfSpeech(101_000, true);

    const previousMin = ep.minDelay;
    const previousMax = ep.maxDelay;
    ep.onEndOfSpeech(101_500, true);

    expect(ep.minDelay).toBe(previousMin);
    expect(ep.maxDelay).toBe(previousMax);
    expect((ep as any).utteranceStartedAt).toBeUndefined();
    expect((ep as any).utteranceEndedAt).toBeUndefined();
  });

  it('test_on_end_of_agent_speech_clears_state', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));

    ep.onStartOfAgentSpeech(100_000);
    ep.onStartOfSpeech(100_100, true);
    expect((ep as any).overlappingState).toBe(true);
    expect((ep as any).agentSpeechStartedAt).toBe(100_000);

    ep.onEndOfAgentSpeech(101_000);

    expect((ep as any).agentSpeechEndedAt).toBe(101_000);
    expect((ep as any).agentSpeechStartedAt).toBe(100_000);
    expect((ep as any).overlappingState).toBe(false);
  });

  it('test_overlapping_inferred_from_agent_speech', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.onEndOfSpeech(100_000);
    ep.onStartOfAgentSpeech(100_900);
    ep.onStartOfSpeech(101_800, false);
    ep.onEndOfSpeech(102_000);

    expectClose(ep.maxDelay, 0.5 * 900 + 0.5 * 1000);
  });

  it('test_speaking_flag_set_and_cleared', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0));

    expect((ep as any).speaking).toBe(false);
    ep.onStartOfSpeech(100_000);
    expect((ep as any).speaking).toBe(true);
    ep.onEndOfSpeech(100_500);
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
    'test_all_overlapping_and_should_ignore_combos [%s]',
    (
      label,
      agentSpeech,
      overlapping,
      shouldIgnore,
      withinGrace,
      expectMinChange,
      expectMaxChange,
    ) => {
      const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

      ep.onStartOfSpeech(toMs(99.0));
      ep.onEndOfSpeech(toMs(100.0));

      let userStart: number;

      if (agentSpeech === 'ended') {
        ep.onStartOfAgentSpeech(toMs(100.5));
        ep.onEndOfAgentSpeech(toMs(101.0));
        userStart = toMs(101.5);
      } else if (agentSpeech === 'active') {
        if (withinGrace) {
          ep.onStartOfAgentSpeech(toMs(100.15));
          userStart = toMs(100.35);
        } else if (overlapping && shouldIgnore) {
          ep.onStartOfAgentSpeech(toMs(100.2));
          userStart = toMs(101.5);
        } else if (overlapping) {
          ep.onStartOfAgentSpeech(toMs(100.15));
          userStart = toMs(100.4);
        } else {
          ep.onStartOfAgentSpeech(toMs(100.9));
          userStart = toMs(101.8);
        }
      } else {
        userStart = toMs(100.4);
      }

      ep.onStartOfSpeech(userStart, overlapping);

      const previousMin = ep.minDelay;
      const previousMax = ep.maxDelay;

      ep.onEndOfSpeech(userStart + toMs(0.5), shouldIgnore);

      const minChanged = ep.minDelay !== previousMin;
      const maxChanged = ep.maxDelay !== previousMax;

      expect(minChanged, `[${label}] minDelay ${previousMin} -> ${ep.minDelay}`).toBe(
        expectMinChange,
      );
      expect(maxChanged, `[${label}] maxDelay ${previousMax} -> ${ep.maxDelay}`).toBe(
        expectMaxChange,
      );
      expect((ep as any).speaking, `[${label}] speaking should be false`).toBe(false);
      expect((ep as any).overlappingState, `[${label}] overlapping should be false`).toBe(false);
    },
  );

  it('test_full_conversation_sequence', () => {
    const ep = new DynamicEndpointing(toMs(0.3), toMs(1.0), 0.5);

    ep.onStartOfSpeech(toMs(100.0));
    ep.onEndOfSpeech(toMs(101.0));

    ep.onStartOfAgentSpeech(toMs(101.5));

    ep.onStartOfSpeech(toMs(102.5), true);
    const minBeforeBackchannel = ep.minDelay;
    const maxBeforeBackchannel = ep.maxDelay;
    ep.onEndOfSpeech(toMs(102.8), true);

    expect(ep.minDelay).toBe(minBeforeBackchannel);
    expect(ep.maxDelay).toBe(maxBeforeBackchannel);

    ep.onEndOfAgentSpeech(toMs(103.0));

    ep.onStartOfSpeech(toMs(103.5));
    ep.onEndOfSpeech(toMs(104.0));

    expect((ep as any).speaking).toBe(false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
  });
});
