// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { ExpFilter } from '../utils.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { DynamicEndpointing } from './endpointing.js';

describe('ExpFilter', () => {
  it('test_initialization_with_valid_alpha', () => {
    const ema = new ExpFilter(0.5);
    expect(ema.value).toBeUndefined();

    const emaWithInitial = new ExpFilter(0.5, { initial: 10 });
    expect(emaWithInitial.value).toBe(10);

    expect(new ExpFilter(1).value).toBeUndefined();
  });

  it('test_initialization_with_invalid_alpha', () => {
    expect(() => new ExpFilter(0)).toThrow('alpha must be in');
    expect(() => new ExpFilter(-0.5)).toThrow('alpha must be in');
    expect(() => new ExpFilter(1.5)).toThrow('alpha must be in');
  });

  it('test_update_with_no_initial_value', () => {
    const ema = new ExpFilter(0.5);
    expect(ema.apply(1, 10)).toBe(10);
    expect(ema.value).toBe(10);
  });

  it('test_update_with_initial_value', () => {
    const ema = new ExpFilter(0.5, { initial: 10 });
    expect(ema.apply(1, 20)).toBe(15);
    expect(ema.value).toBe(15);
  });

  it('test_update_multiple_times', () => {
    const ema = new ExpFilter(0.5, { initial: 10 });
    ema.apply(1, 20);
    ema.apply(1, 20);
    expect(ema.value).toBe(17.5);
  });

  it('test_reset', () => {
    const ema = new ExpFilter(0.5, { initial: 10 });
    expect(ema.value).toBe(10);
    ema.reset();
    expect(ema.value).toBe(10);

    const emaWithReset = new ExpFilter(0.5, { initial: 10 });
    emaWithReset.reset({ initial: 5 });
    expect(emaWithReset.value).toBe(5);
  });
});

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
    const state = ep as any;
    expect(state.utterancePause.alpha).toBeCloseTo(0.9, 5);
    expect(state.turnPause.alpha).toBeCloseTo(0.9, 5);
  });

  it('test_empty_delays', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect(ep.betweenUtteranceDelay).toBe(0);
    expect(ep.betweenTurnDelay).toBe(0);
    expect(ep.immediateInterruptionDelay).toEqual([0, 0]);
  });

  it('test_on_utterance_ended', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    expect((ep as any).utteranceEndedAt).toBe(100000);

    const second = new DynamicEndpointing(300, 1000);
    second.onEndOfSpeech(99900);
    expect((second as any).utteranceEndedAt).toBe(99900);
  });

  it('test_on_utterance_started', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfSpeech(100000);
    expect((ep as any).utteranceStartedAt).toBe(100000);
  });

  it('test_on_agent_speech_started', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfAgentSpeech(100000);
    expect((ep as any).agentSpeechStartedAt).toBe(100000);
  });

  it('test_between_utterance_delay_calculation', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100500);
    expect(ep.betweenUtteranceDelay).toBeCloseTo(500, 5);
  });

  it('test_between_turn_delay_calculation', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100800);
    expect(ep.betweenTurnDelay).toBeCloseTo(800, 5);
  });

  it('test_pause_between_utterances_updates_min_delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100400);
    ep.onEndOfSpeech(100500, false);

    expect(ep.minDelay).toBeCloseTo(0.5 * 400 + 0.5 * initialMin, 5);
  });

  it('test_new_turn_updates_max_delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100600);
    ep.onStartOfSpeech(101500);
    ep.onEndOfSpeech(102000, false);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 600 + 0.5 * 1000, 5);
  });

  it('test_interruption_updates_min_delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    expect((ep as any).agentSpeechStartedAt).toBeDefined();
    ep.onStartOfSpeech(100250, true);
    expect((ep as any).overlappingState).toBe(true);

    ep.onEndOfSpeech(100500);

    expect((ep as any).overlappingState).toBe(false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
    expect(ep.minDelay).toBeCloseTo(300, 5);
  });

  it('test_update_options', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.updateOptions({ minDelay: 500 });
    expect(ep.minDelay).toBe(500);
    expect((ep as any).minDelayBase).toBe(500);

    const maxOnly = new DynamicEndpointing(300, 1000);
    maxOnly.updateOptions({ maxDelay: 2000 });
    expect(maxOnly.maxDelay).toBe(2000);
    expect((maxOnly as any).maxDelayBase).toBe(2000);

    const both = new DynamicEndpointing(300, 1000);
    both.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect(both.minDelay).toBe(500);
    expect(both.maxDelay).toBe(2000);

    const none = new DynamicEndpointing(300, 1000);
    none.updateOptions();
    expect(none.minDelay).toBe(300);
    expect(none.maxDelay).toBe(1000);
  });

  it('test_max_delay_clamped_to_configured_max', () => {
    const ep = new DynamicEndpointing(300, 1000, 1);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(102000);
    ep.onStartOfSpeech(105000);
    expect(ep.maxDelay).toBe(1000);
  });

  it('test_max_delay_clamped_to_min_delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 1);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100100);
    ep.onStartOfSpeech(100500);
    expect(ep.maxDelay).toBeGreaterThanOrEqual((ep as any).minDelayBase);
  });

  it('test_non_interruption_clears_agent_speech', () => {
    const ep = new DynamicEndpointing(300, 1000);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    expect((ep as any).agentSpeechStartedAt).toBeDefined();

    ep.onStartOfSpeech(102000);
    ep.onEndOfSpeech(103000, false);
    expect((ep as any).agentSpeechStartedAt).toBeUndefined();
  });

  it('test_consecutive_interruptions_only_track_first', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    ep.onStartOfSpeech(100250, true);

    const previous = [ep.minDelay, ep.maxDelay];
    ep.onStartOfSpeech(100350);

    expect((ep as any).overlappingState).toBe(true);
    expect([ep.minDelay, ep.maxDelay]).toEqual(previous);
  });

  it('test_delayed_interruption_updates_max_delay_without_crashing', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100900);
    ep.onStartOfSpeech(101800);
    ep.onEndOfSpeech(102000, false);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 900 + 0.5 * 1000, 5);
  });

  it('test_interruption_adjusts_stale_utterance_end_time', () => {
    const ep = new DynamicEndpointing(60, 1000, 1);

    ep.onEndOfSpeech(99000);
    ep.onStartOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    ep.onStartOfSpeech(100250, true);

    expect((ep as any).utteranceEndedAt).toBeCloseTo(100199, 5);
    expect(ep.minDelay).toBeCloseTo(60, 5);
    expect(ep.maxDelay).toBeCloseTo(1000, 5);
  });

  it('test_update_options_preserves_filter_alpha', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.updateOptions({ minDelay: 600, maxDelay: 2000 });

    const state = ep as any;
    expect(state.utterancePause.alpha).toBeCloseTo(0.5, 5);
    expect(state.turnPause.alpha).toBeCloseTo(0.5, 5);
  });

  it('test_update_options_updates_filter_clamp_bounds', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.updateOptions({ minDelay: 500, maxDelay: 2000 });
    const state = ep as any;
    expect(state.utterancePause.min).toBe(500);
    expect(state.turnPause.max).toBe(2000);

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100200);
    expect(ep.minDelay).toBeCloseTo(500, 5);

    ep.onEndOfSpeech(101000);
    ep.onStartOfAgentSpeech(102800);
    ep.onStartOfSpeech(103500);
    expect(ep.maxDelay).toBeGreaterThan(1000);
    expect(ep.maxDelay).toBeLessThanOrEqual(2000);
  });

  it('test_should_ignore_skips_filter_update', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    ep.onStartOfSpeech(101500, true);

    const previousMin = ep.minDelay;
    const previousMax = ep.maxDelay;

    ep.onEndOfSpeech(101800, true);

    const state = ep as any;
    expect(ep.minDelay).toBe(previousMin);
    expect(ep.maxDelay).toBe(previousMax);
    expect(state.utteranceStartedAt).toBeUndefined();
    expect(state.utteranceEndedAt).toBeUndefined();
    expect(state.overlappingState).toBe(false);
    expect(state.speaking).toBe(false);
  });

  it('test_should_ignore_without_overlapping_still_updates', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100400, false);
    ep.onEndOfSpeech(100600, true);

    expect(ep.minDelay).toBeCloseTo(0.5 * 400 + 0.5 * initialMin, 5);
  });

  it('test_should_ignore_grace_period_overrides', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    ep.onStartOfSpeech(100600, true);
    ep.onEndOfSpeech(100800, true);

    expect((ep as any).utteranceEndedAt).toBe(100800);
    expect((ep as any).speaking).toBe(false);
  });

  it('test_should_ignore_outside_grace_period', () => {
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

  it('test_on_end_of_agent_speech_clears_state', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfAgentSpeech(100000);
    ep.onStartOfSpeech(100100, true);

    expect((ep as any).overlappingState).toBe(true);
    expect((ep as any).agentSpeechStartedAt).toBe(100000);

    ep.onEndOfAgentSpeech(101000);

    expect((ep as any).agentSpeechEndedAt).toBe(101000);
    expect((ep as any).agentSpeechStartedAt).toBe(100000);
    expect((ep as any).overlappingState).toBe(false);
  });

  it('test_overlapping_inferred_from_agent_speech', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100900);
    ep.onStartOfSpeech(101800, false);
    ep.onEndOfSpeech(102000);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 900 + 0.5 * 1000, 5);
  });

  it('test_speaking_flag_set_and_cleared', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect((ep as any).speaking).toBe(false);
    ep.onStartOfSpeech(100000);
    expect((ep as any).speaking).toBe(true);
    ep.onEndOfSpeech(100500);
    expect((ep as any).speaking).toBe(false);
  });

  it('test_all_overlapping_and_should_ignore_combos', () => {
    const cases = [
      ['no_agent/no_overlap/no_ignore', 'none', false, false, false, true, false],
      ['no_agent/no_overlap/ignore', 'none', false, true, false, true, false],
      ['agent_ended/no_overlap/no_ignore', 'ended', false, false, false, false, true],
      ['agent_ended/no_overlap/ignore', 'ended', false, true, false, false, true],
      ['agent_active/no_overlap/no_ignore', 'active', false, false, false, false, true],
      ['agent_active/no_overlap/ignore', 'active', false, true, false, false, true],
      ['agent_active/overlap/no_ignore', 'active', true, false, false, true, false],
      ['agent_active/overlap/ignore/outside_grace', 'active', true, true, false, false, false],
      ['agent_active/overlap/ignore/inside_grace', 'active', true, true, true, true, false],
    ] as const;

    for (const [
      label,
      agentSpeech,
      overlapping,
      shouldIgnore,
      withinGrace,
      expectMinChange,
      expectMaxChange,
    ] of cases) {
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

      expect(minChanged, `[${label}] minDelay change mismatch`).toBe(expectMinChange);
      expect(maxChanged, `[${label}] maxDelay change mismatch`).toBe(expectMaxChange);
      expect((ep as any).speaking, `[${label}] speaking should be false`).toBe(false);
      expect((ep as any).overlappingState, `[${label}] overlapping should be false`).toBe(false);
    }
  });

  it('test_full_conversation_sequence', () => {
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

describe('AudioRecognition endpointing integration', () => {
  function createHooks(): RecognitionHooks {
    return {
      onInterruption: () => undefined,
      onStartOfSpeech: () => undefined,
      onVADInferenceDone: () => undefined,
      onEndOfSpeech: () => undefined,
      onInterimTranscript: () => undefined,
      onFinalTranscript: () => undefined,
      onEndOfTurn: async () => true,
      onPreemptiveGeneration: () => undefined,
      retrieveChatCtx: () => ChatContext.empty(),
    };
  }

  it('updates dynamic max delay without adaptive interruption detection', async () => {
    const endpointing = new DynamicEndpointing(300, 1000, 0.5);
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing,
    });

    recognition.onStartOfSpeech(99000);
    recognition.onEndOfSpeech(100000);
    await recognition.onStartOfAgentSpeech(100900);
    recognition.onStartOfSpeech(101800);
    recognition.onEndOfSpeech(102000);

    expect(endpointing.maxDelay).toBeCloseTo(0.5 * 900 + 0.5 * 1000, 5);
  });

  it('replaces the endpointing strategy on updateOptions', () => {
    const original = new DynamicEndpointing(300, 1000, 0.5);
    original.onEndOfSpeech(100000);
    original.onStartOfSpeech(100400);
    original.onEndOfSpeech(100600);

    const replacement = new DynamicEndpointing(500, 2000, 0.5);
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing: original,
    });

    recognition.updateOptions({ endpointing: replacement, turnDetection: undefined });

    expect((recognition as any).endpointing).toBe(replacement);
    expect(replacement.minDelay).toBe(500);
    expect(original.minDelay).not.toBe(replacement.minDelay);
  });
});
