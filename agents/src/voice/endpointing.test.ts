// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { ExpFilter } from '../utils.js';
import { AgentActivity } from './agent_activity.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { BaseEndpointing, DynamicEndpointing, createEndpointing } from './endpointing.js';

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

function hooks(): RecognitionHooks {
  return {
    onInterruption: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onEndOfTurn: vi.fn(async () => true),
    onPreemptiveGeneration: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
  };
}

// Ref: python tests/test_endpointing.py - 7-63 lines
describe('TestExponentialMovingAverage', () => {
  it('test_initialization_with_valid_alpha', () => {
    const ema = new ExpFilter(0.5);
    expect(ema.value).toBeUndefined();

    const emaWithInitial = new ExpFilter(0.5, undefined, undefined, 10.0);
    expect(emaWithInitial.value).toBe(10.0);

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
    let ema = new ExpFilter(0.5, undefined, undefined, 10.0);
    expect(ema.value).toBe(10.0);
    ema.reset();
    expect(ema.value).toBe(10.0);

    ema = new ExpFilter(0.5, undefined, undefined, 10.0);
    ema.reset(undefined, 5.0);
    expect(ema.value).toBe(5.0);
  });
});

// Ref: python tests/test_endpointing.py - 64-564 lines
describe('TestDynamicEndpointing', () => {
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
    expect((ep as any)._utterancePause._alpha).toBeCloseTo(0.9, 5);
    expect((ep as any)._turnPause._alpha).toBeCloseTo(0.9, 5);
  });

  it('test_empty_delays', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect(ep.betweenUtteranceDelay).toBe(0.0);
    expect(ep.betweenTurnDelay).toBe(0.0);
    expect(ep.immediateInterruptionDelay).toEqual([0.0, 0.0]);
  });

  it('test_on_utterance_ended', () => {
    let ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    expect((ep as any)._utteranceEndedAt).toBe(100000);

    ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(99900);
    expect((ep as any)._utteranceEndedAt).toBe(99900);
  });

  it('test_on_utterance_started', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfSpeech(100000);
    expect((ep as any)._utteranceStartedAt).toBe(100000);
  });

  it('test_on_agent_speech_started', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfAgentSpeech(100000);
    expect((ep as any)._agentSpeechStartedAt).toBe(100000);
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
    expect((ep as any)._agentSpeechStartedAt).not.toBeUndefined();
    ep.onStartOfSpeech(100250, true);
    expect((ep as any)._overlapping).toBe(true);
    ep.onEndOfSpeech(100500);
    expect((ep as any)._overlapping).toBe(false);
    expect((ep as any)._agentSpeechStartedAt).toBeUndefined();
    expect(ep.minDelay).toBeCloseTo(300, 5);
  });

  it('test_update_options', () => {
    let ep = new DynamicEndpointing(300, 1000);
    ep.updateOptions({ minDelay: 500 });
    expect(ep.minDelay).toBe(500);
    expect((ep as any)._minDelay).toBe(500);

    ep = new DynamicEndpointing(300, 1000);
    ep.updateOptions({ maxDelay: 2000 });
    expect(ep.maxDelay).toBe(2000);
    expect((ep as any)._maxDelay).toBe(2000);

    ep = new DynamicEndpointing(300, 1000);
    ep.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect(ep.minDelay).toBe(500);
    expect(ep.maxDelay).toBe(2000);

    ep = new DynamicEndpointing(300, 1000);
    ep.updateOptions();
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  it('test_max_delay_clamped_to_configured_max', () => {
    const ep = new DynamicEndpointing(300, 1000, 1.0);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(102000);
    ep.onStartOfSpeech(105000);
    expect(ep.maxDelay).toBe(1000);
  });

  it('test_max_delay_clamped_to_min_delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 1.0);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100100);
    ep.onStartOfSpeech(100500);
    expect(ep.maxDelay).toBeGreaterThanOrEqual((ep as any)._minDelay);
  });

  it('test_non_interruption_clears_agent_speech', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    expect((ep as any)._agentSpeechStartedAt).not.toBeUndefined();
    ep.onStartOfSpeech(102000);
    ep.onEndOfSpeech(103000, false);
    expect((ep as any)._agentSpeechStartedAt).toBeUndefined();
  });

  it('test_consecutive_interruptions_only_track_first', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    ep.onStartOfSpeech(100250, true);
    expect((ep as any)._overlapping).toBe(true);
    const prevVal = [ep.minDelay, ep.maxDelay];
    ep.onStartOfSpeech(100350);
    expect((ep as any)._overlapping).toBe(true);
    expect(prevVal).toEqual([ep.minDelay, ep.maxDelay]);
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
    const ep = new DynamicEndpointing(60, 1000, 1.0);
    ep.onEndOfSpeech(99000);
    ep.onStartOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    ep.onStartOfSpeech(100250, true);
    expect((ep as any)._utteranceEndedAt).toBeCloseTo(100199, 5);
    expect(ep.minDelay).toBeCloseTo(60, 5);
    expect(ep.maxDelay).toBeCloseTo(1000, 5);
  });

  it('test_update_options_preserves_filter_alpha', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.updateOptions({ minDelay: 600, maxDelay: 2000 });
    expect((ep as any)._utterancePause._alpha).toBeCloseTo(0.5, 5);
    expect((ep as any)._turnPause._alpha).toBeCloseTo(0.5, 5);
  });

  it('test_update_options_updates_alpha_in_place', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100200);
    ep.onEndOfSpeech(101000);
    const learnedMin = ep.minDelay;
    ep.updateOptions({ alpha: 0.2 });
    expect((ep as any)._utterancePause._alpha).toBeCloseTo(0.2, 5);
    expect((ep as any)._turnPause._alpha).toBeCloseTo(0.2, 5);
    expect(ep.minDelay).toBeCloseTo(learnedMin, 5);
  });

  it('test_update_options_updates_filter_clamp_bounds', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect((ep as any)._utterancePause._minVal).toBe(500);
    expect((ep as any)._turnPause._maxVal).toBe(2000);

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
    const prevMin = ep.minDelay;
    const prevMax = ep.maxDelay;
    ep.onEndOfSpeech(101800, true);
    expect(ep.minDelay).toBe(prevMin);
    expect(ep.maxDelay).toBe(prevMax);
    expect((ep as any)._utteranceStartedAt).toBeUndefined();
    expect((ep as any)._utteranceEndedAt).toBeUndefined();
    expect((ep as any)._overlapping).toBe(false);
    expect((ep as any)._speaking).toBe(false);
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
    expect((ep as any)._utteranceEndedAt).toBe(100800);
    expect((ep as any)._speaking).toBe(false);
  });

  it('test_should_ignore_outside_grace_period', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    ep.onStartOfSpeech(101000, true);
    const prevMin = ep.minDelay;
    const prevMax = ep.maxDelay;
    ep.onEndOfSpeech(101500, true);
    expect(ep.minDelay).toBe(prevMin);
    expect(ep.maxDelay).toBe(prevMax);
    expect((ep as any)._utteranceStartedAt).toBeUndefined();
    expect((ep as any)._utteranceEndedAt).toBeUndefined();
  });

  it('test_on_end_of_agent_speech_clears_state', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfAgentSpeech(100000);
    ep.onStartOfSpeech(100100, true);
    expect((ep as any)._overlapping).toBe(true);
    expect((ep as any)._agentSpeechStartedAt).toBe(100000);
    ep.onEndOfAgentSpeech(101000);
    expect((ep as any)._agentSpeechEndedAt).toBe(101000);
    expect((ep as any)._agentSpeechStartedAt).toBe(100000);
    expect((ep as any)._overlapping).toBe(false);
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
    expect((ep as any)._speaking).toBe(false);
    ep.onStartOfSpeech(100000);
    expect((ep as any)._speaking).toBe(true);
    ep.onEndOfSpeech(100500);
    expect((ep as any)._speaking).toBe(false);
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
      ep.onStartOfSpeech(99000);
      ep.onEndOfSpeech(100000);

      let userStart: number;
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
      } else {
        userStart = 100400;
      }

      ep.onStartOfSpeech(userStart, overlapping as boolean);
      const prevMin = ep.minDelay;
      const prevMax = ep.maxDelay;
      ep.onEndOfSpeech(userStart + 500, shouldIgnore as boolean);

      expect(ep.minDelay !== prevMin, `[${label}] min_delay change`).toBe(expectMinChange);
      expect(ep.maxDelay !== prevMax, `[${label}] max_delay change`).toBe(expectMaxChange);
      expect((ep as any)._speaking, `[${label}] _speaking should be false`).toBe(false);
      expect((ep as any)._overlapping, `[${label}] _overlapping should be false`).toBe(false);
    },
  );

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
    expect((ep as any)._speaking).toBe(false);
    expect((ep as any)._agentSpeechStartedAt).toBeUndefined();
  });
});

// Ref: python tests/test_endpointing.py - 565-581 lines
describe('TestCreateEndpointing', () => {
  it('test_dynamic_mode_wires_alpha', () => {
    const ep = createEndpointing({ mode: 'dynamic', minDelay: 300, maxDelay: 1000, alpha: 0.7 });
    expect(ep).toBeInstanceOf(DynamicEndpointing);
    expect((ep as any)._utterancePause._alpha).toBeCloseTo(0.7, 5);
    expect((ep as any)._turnPause._alpha).toBeCloseTo(0.7, 5);
  });

  it('test_fixed_mode_returns_base_endpointing', () => {
    const ep = createEndpointing({ mode: 'fixed', minDelay: 500, maxDelay: 3000, alpha: 0.9 });
    expect(ep).toBeInstanceOf(BaseEndpointing);
    expect(ep).not.toBeInstanceOf(DynamicEndpointing);
    expect(ep.minDelay).toBe(500);
    expect(ep.maxDelay).toBe(3000);
  });
});

describe('Target dynamic endpointing integration', () => {
  it('routes no-VAD realtime speech lifecycle into AudioRecognition endpointing hooks', () => {
    const activity = Object.create(AgentActivity.prototype) as AgentActivity & {
      audioRecognition: {
        onStartOfSpeech: ReturnType<typeof vi.fn>;
        onEndOfSpeech: ReturnType<typeof vi.fn>;
      };
      agent: { vad?: unknown };
      interrupt: ReturnType<typeof vi.fn>;
      logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
      agentSession: {
        vad?: unknown;
        _userSpeakingSpan?: unknown;
        _updateUserState: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
      };
    };
    activity.agent = { vad: undefined };
    activity.audioRecognition = { onStartOfSpeech: vi.fn(), onEndOfSpeech: vi.fn() };
    activity.interrupt = vi.fn();
    activity.logger = { info: vi.fn(), error: vi.fn() };
    activity.agentSession = {
      vad: undefined,
      _updateUserState: vi.fn(),
      emit: vi.fn(),
    };

    activity.onInputSpeechStarted({} as any);
    activity.onInputSpeechStopped({ userTranscriptionEnabled: false } as any);

    expect(activity.audioRecognition.onStartOfSpeech).toHaveBeenCalledWith(
      expect.any(Number),
      0,
      undefined,
    );
    expect(activity.audioRecognition.onEndOfSpeech).toHaveBeenCalledWith(
      expect.any(Number),
      undefined,
    );
  });

  it('updates agent speech endpointing even when adaptive interruption is disabled', async () => {
    const endpointing = new DynamicEndpointing(300, 1000);
    const recognition = new AudioRecognition({ recognitionHooks: hooks(), endpointing });

    await recognition.onStartOfAgentSpeech(100500);
    await recognition.onEndOfAgentSpeech(101000);

    expect((endpointing as any)._agentSpeechStartedAt).toBe(100500);
    expect((endpointing as any)._agentSpeechEndedAt).not.toBeUndefined();
    await recognition.close();
  });

  it('replaces endpointing through updateOptions and intentionally resets runtime state', async () => {
    const first = new DynamicEndpointing(300, 1000);
    const second = new DynamicEndpointing(500, 2000);
    const recognition = new AudioRecognition({ recognitionHooks: hooks(), endpointing: first });

    recognition.updateOptions({ endpointing: second });

    expect((recognition as any).endpointing).toBe(second);
    expect((recognition as any).endpointing).not.toBe(first);
    await recognition.close();
  });
});
