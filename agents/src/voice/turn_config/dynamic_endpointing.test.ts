// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import type { ExpFilter } from '../../utils.js';
import { BaseEndpointing, DynamicEndpointing, createEndpointing } from './dynamic_endpointing.js';

initializeLogger({ pretty: false, level: 'silent' });

/** Private-field accessor shape for introspecting `DynamicEndpointing` internals from tests. */
interface DynamicEndpointingInternals {
  _utterancePause: ExpFilter & { _min?: number; _max?: number };
  _turnPause: ExpFilter & { _min?: number; _max?: number };
  _utteranceStartedAt?: number;
  _utteranceEndedAt?: number;
  _agentSpeechStartedAt?: number;
  _agentSpeechEndedAt?: number;
  _speaking: boolean;
  _overlapping: boolean;
  _minDelay: number;
  _maxDelay: number;
}

function peek(ep: DynamicEndpointing): DynamicEndpointingInternals {
  return ep as unknown as DynamicEndpointingInternals;
}

// Time values in the ported tests are in milliseconds. Python test values (in seconds) are
// multiplied by 1000: `0.3s → 300ms`, `100.0s → 100000ms`, `0.25s grace → 250ms`. Alpha is
// unitless so it stays unchanged.

// Ref: python tests/test_endpointing.py - 64-545 lines
describe('DynamicEndpointing', () => {
  // Ref: python tests/test_endpointing.py - 67-71 lines
  it('test_initialization', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  // Ref: python tests/test_endpointing.py - 73-77 lines
  it('test_initialization_with_custom_alpha', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.2 });
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  // Ref: python tests/test_endpointing.py - 79-82 lines
  it('test_initialization_uses_updated_default_alpha', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    const any = peek(ep);
    expect(any._utterancePause.alpha).toBeCloseTo(0.9, 5);
    expect(any._turnPause.alpha).toBeCloseTo(0.9, 5);
  });

  // Ref: python tests/test_endpointing.py - 84-89 lines
  it('test_empty_delays', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    expect(ep.betweenUtteranceDelay).toBe(0);
    expect(ep.betweenTurnDelay).toBe(0);
    expect(ep.immediateInterruptionDelay).toEqual([0, 0]);
  });

  // Ref: python tests/test_endpointing.py - 91-98 lines
  it('test_on_utterance_ended', () => {
    let ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.onEndOfSpeech(100000);
    expect(peek(ep)._utteranceEndedAt).toBe(100000);

    ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.onEndOfSpeech(99900);
    expect(peek(ep)._utteranceEndedAt).toBe(99900);
  });

  // Ref: python tests/test_endpointing.py - 100-103 lines
  it('test_on_utterance_started', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.onStartOfSpeech(100000);
    expect(peek(ep)._utteranceStartedAt).toBe(100000);
  });

  // Ref: python tests/test_endpointing.py - 105-108 lines
  it('test_on_agent_speech_started', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.onStartOfAgentSpeech(100000);
    expect(peek(ep)._agentSpeechStartedAt).toBe(100000);
  });

  // Ref: python tests/test_endpointing.py - 110-117 lines
  it('test_between_utterance_delay_calculation', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100500);
    expect(ep.betweenUtteranceDelay).toBeCloseTo(500, 5);
  });

  // Ref: python tests/test_endpointing.py - 119-126 lines
  it('test_between_turn_delay_calculation', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100800);
    expect(ep.betweenTurnDelay).toBeCloseTo(800, 5);
  });

  // Ref: python tests/test_endpointing.py - 128-138 lines
  it('test_pause_between_utterances_updates_min_delay', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100400);
    ep.onEndOfSpeech(100500, false);
    // pause = 400; EMA: 0.5 * 400 + 0.5 * 300 = 350
    const expected = 0.5 * 400 + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  // Ref: python tests/test_endpointing.py - 140-149 lines
  it('test_new_turn_updates_max_delay', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100600);
    ep.onStartOfSpeech(101500);
    ep.onEndOfSpeech(102000, false);
    expect(ep.maxDelay).toBeCloseTo(0.5 * 600 + 0.5 * 1000, 5);
  });

  // Ref: python tests/test_endpointing.py - 151-167 lines
  it('test_interruption_updates_min_delay', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    expect(peek(ep)._agentSpeechStartedAt).not.toBeUndefined();
    ep.onStartOfSpeech(100250, true);
    expect(peek(ep)._overlapping).toBe(true);

    ep.onEndOfSpeech(100500);

    // pause = 250; clamped to max(250, 300) = 300; EMA: 0.5 * 300 + 0.5 * 300 = 300
    expect(peek(ep)._overlapping).toBe(false);
    expect(peek(ep)._agentSpeechStartedAt).toBeUndefined();
    expect(ep.minDelay).toBeCloseTo(300, 5);
  });

  // Ref: python tests/test_endpointing.py - 169-188 lines
  it('test_update_options', () => {
    let ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.updateOptions({ minDelay: 500 });
    expect(ep.minDelay).toBe(500);
    expect(peek(ep)._minDelay).toBe(500);

    ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.updateOptions({ maxDelay: 2000 });
    expect(ep.maxDelay).toBe(2000);
    expect(peek(ep)._maxDelay).toBe(2000);

    ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect(ep.minDelay).toBe(500);
    expect(ep.maxDelay).toBe(2000);

    ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.updateOptions();
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  // Ref: python tests/test_endpointing.py - 190-198 lines
  it('test_max_delay_clamped_to_configured_max', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 1.0 });
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(102000);
    ep.onStartOfSpeech(105000);
    expect(ep.maxDelay).toBe(1000); // pause=2000 clamped to _maxDelay
  });

  // Ref: python tests/test_endpointing.py - 200-208 lines
  it('test_max_delay_clamped_to_min_delay', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 1.0 });
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100100);
    ep.onStartOfSpeech(100500);
    expect(ep.maxDelay).toBeGreaterThanOrEqual(peek(ep)._minDelay);
  });

  // Ref: python tests/test_endpointing.py - 210-220 lines
  it('test_non_interruption_clears_agent_speech', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    expect(peek(ep)._agentSpeechStartedAt).not.toBeUndefined();

    ep.onStartOfSpeech(102000);
    ep.onEndOfSpeech(103000, false);
    expect(peek(ep)._agentSpeechStartedAt).toBeUndefined();
  });

  // Ref: python tests/test_endpointing.py - 222-236 lines
  it('test_consecutive_interruptions_only_track_first', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    ep.onStartOfSpeech(100250, true);

    expect(peek(ep)._overlapping).toBe(true);
    const prev = [ep.minDelay, ep.maxDelay];

    ep.onStartOfSpeech(100350);

    expect(peek(ep)._overlapping).toBe(true);
    expect([ep.minDelay, ep.maxDelay]).toEqual(prev);
  });

  // Ref: python tests/test_endpointing.py - 238-247 lines
  it('test_delayed_interruption_updates_max_delay_without_crashing', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100900);
    ep.onStartOfSpeech(101800);
    ep.onEndOfSpeech(102000, false);

    expect(ep.maxDelay).toBeCloseTo(0.5 * 900 + 0.5 * 1000, 5);
  });

  // Ref: python tests/test_endpointing.py - 249-262 lines
  it('test_interruption_adjusts_stale_utterance_end_time', () => {
    const ep = new DynamicEndpointing({ minDelay: 60, maxDelay: 1000, alpha: 1.0 });

    // Simulate stale ordering where end timestamp still belongs to a previous utterance.
    ep.onEndOfSpeech(99000);
    ep.onStartOfSpeech(100000);

    ep.onStartOfAgentSpeech(100200);
    ep.onStartOfSpeech(100250, true);

    expect(peek(ep)._utteranceEndedAt).toBeCloseTo(100200, 0);
    expect(ep.minDelay).toBeCloseTo(60, 5);
    expect(ep.maxDelay).toBeCloseTo(1000, 5);
  });

  // Ref: python tests/test_endpointing.py - 264-271 lines
  it('test_update_options_preserves_filter_alpha', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    ep.updateOptions({ minDelay: 600, maxDelay: 2000 });

    const any = peek(ep);
    expect(any._utterancePause.alpha).toBeCloseTo(0.5, 5);
    expect(any._turnPause.alpha).toBeCloseTo(0.5, 5);
  });

  // Ref: python tests/test_endpointing.py - 273-290 lines
  it('test_update_options_updates_filter_clamp_bounds', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    ep.updateOptions({ minDelay: 500, maxDelay: 2000 });
    const any = peek(ep);
    expect(any._utterancePause._min).toBe(500);
    expect(any._turnPause._max).toBe(2000);

    // minDelay updated from 300 to 500
    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100200);
    expect(ep.minDelay).toBeCloseTo(500, 5);

    // maxDelay updated from 1000 to 2000
    ep.onEndOfSpeech(101000);
    ep.onStartOfAgentSpeech(102800);
    ep.onStartOfSpeech(103500);
    expect(ep.maxDelay).toBeGreaterThan(1000);
    expect(ep.maxDelay).toBeLessThanOrEqual(2000);
  });

  // Ref: python tests/test_endpointing.py - 292-313 lines
  it('test_should_ignore_skips_filter_update', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    // user starts 1.0s (1000ms) after agent (well outside 250ms grace period)
    ep.onStartOfSpeech(101500, true);

    const prevMin = ep.minDelay;
    const prevMax = ep.maxDelay;

    ep.onEndOfSpeech(101800, true);

    // filters should not have been updated
    expect(ep.minDelay).toBe(prevMin);
    expect(ep.maxDelay).toBe(prevMax);
    // state should be reset
    const any = peek(ep);
    expect(any._utteranceStartedAt).toBeUndefined();
    expect(any._utteranceEndedAt).toBeUndefined();
    expect(any._overlapping).toBe(false);
    expect(any._speaking).toBe(false);
  });

  // Ref: python tests/test_endpointing.py - 315-326 lines
  it('test_should_ignore_without_overlapping_still_updates', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100400, false);
    ep.onEndOfSpeech(100600, true);

    // shouldIgnore only gates when overlapping, so minDelay should update (case 1)
    const expected = 0.5 * 400 + 0.5 * initialMin;
    expect(ep.minDelay).toBeCloseTo(expected, 5);
  });

  // Ref: python tests/test_endpointing.py - 328-342 lines
  it('test_should_ignore_grace_period_overrides', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    // user starts speaking 100ms after agent (within 250ms grace period)
    ep.onStartOfSpeech(100600, true);

    ep.onEndOfSpeech(100800, true);

    // grace period should override shouldIgnore, so the interruption path runs
    // and state is properly cleaned up (not left as undefined)
    const any = peek(ep);
    expect(any._utteranceEndedAt).toBe(100800);
    expect(any._speaking).toBe(false);
  });

  // Ref: python tests/test_endpointing.py - 344-361 lines
  it('test_should_ignore_outside_grace_period', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    // user starts speaking 500ms after agent (outside 250ms grace period)
    ep.onStartOfSpeech(101000, true);

    const prevMin = ep.minDelay;
    const prevMax = ep.maxDelay;
    ep.onEndOfSpeech(101500, true);

    // outside grace period, shouldIgnore takes effect — no filter update
    expect(ep.minDelay).toBe(prevMin);
    expect(ep.maxDelay).toBe(prevMax);
    const any = peek(ep);
    expect(any._utteranceStartedAt).toBeUndefined();
    expect(any._utteranceEndedAt).toBeUndefined();
  });

  // Ref: python tests/test_endpointing.py - 363-378 lines
  it('test_on_end_of_agent_speech_clears_state', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });

    ep.onStartOfAgentSpeech(100000);
    ep.onStartOfSpeech(100100, true);
    expect(peek(ep)._overlapping).toBe(true);
    expect(peek(ep)._agentSpeechStartedAt).toBe(100000);

    ep.onEndOfAgentSpeech(101000);

    const any = peek(ep);
    expect(any._agentSpeechEndedAt).toBe(101000);
    // _agentSpeechStartedAt is intentionally preserved so that betweenTurnDelay can be computed
    // in the normal end-of-speech path
    expect(any._agentSpeechStartedAt).toBe(100000);
    expect(any._overlapping).toBe(false);
  });

  // Ref: python tests/test_endpointing.py - 380-392 lines
  it('test_overlapping_inferred_from_agent_speech', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100900);
    // overlapping not explicitly set
    ep.onStartOfSpeech(101800, false);
    ep.onEndOfSpeech(102000);

    // _agentSpeechStartedAt set → interruption path → case 3 (delayed) updates maxDelay
    // betweenTurnDelay = 900
    expect(ep.maxDelay).toBeCloseTo(0.5 * 900 + 0.5 * 1000, 5);
  });

  // Ref: python tests/test_endpointing.py - 394-402 lines
  it('test_speaking_flag_set_and_cleared', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000 });

    expect(peek(ep)._speaking).toBe(false);
    ep.onStartOfSpeech(100000);
    expect(peek(ep)._speaking).toBe(true);
    ep.onEndOfSpeech(100500);
    expect(peek(ep)._speaking).toBe(false);
  });

  // Ref: python tests/test_endpointing.py - 404-509 lines
  describe('test_all_overlapping_and_should_ignore_combos', () => {
    type AgentSpeech = 'none' | 'ended' | 'active';
    interface Case {
      label: string;
      agentSpeech: AgentSpeech;
      overlapping: boolean;
      shouldIgnore: boolean;
      withinGrace: boolean;
      expectMinChange: boolean;
      expectMaxChange: boolean;
    }

    const cases: Case[] = [
      // --- No agent speech ---
      // Case 1: pause between utterances updates minDelay
      {
        label: 'no_agent/no_overlap/no_ignore',
        agentSpeech: 'none',
        overlapping: false,
        shouldIgnore: false,
        withinGrace: false,
        expectMinChange: true,
        expectMaxChange: false,
      },
      // shouldIgnore is ignored when not overlapping
      {
        label: 'no_agent/no_overlap/ignore',
        agentSpeech: 'none',
        overlapping: false,
        shouldIgnore: true,
        withinGrace: false,
        expectMinChange: true,
        expectMaxChange: false,
      },
      // --- Agent speech ended ---
      // agent finished speaking → normal path, betweenTurnDelay > 0 → case 3 updates max
      {
        label: 'agent_ended/no_overlap/no_ignore',
        agentSpeech: 'ended',
        overlapping: false,
        shouldIgnore: false,
        withinGrace: false,
        expectMinChange: false,
        expectMaxChange: true,
      },
      {
        label: 'agent_ended/no_overlap/ignore',
        agentSpeech: 'ended',
        overlapping: false,
        shouldIgnore: true,
        withinGrace: false,
        expectMinChange: false,
        expectMaxChange: true,
      },
      // --- Agent speech active ---
      // Inferred interruption from agentSpeechStartedAt → case 3 (delayed)
      {
        label: 'agent_active/no_overlap/no_ignore',
        agentSpeech: 'active',
        overlapping: false,
        shouldIgnore: false,
        withinGrace: false,
        expectMinChange: false,
        expectMaxChange: true,
      },
      // shouldIgnore ignored when not overlapping
      {
        label: 'agent_active/no_overlap/ignore',
        agentSpeech: 'active',
        overlapping: false,
        shouldIgnore: true,
        withinGrace: false,
        expectMinChange: false,
        expectMaxChange: true,
      },
      // Explicit overlapping, immediate → case 2 updates minDelay
      {
        label: 'agent_active/overlap/no_ignore',
        agentSpeech: 'active',
        overlapping: true,
        shouldIgnore: false,
        withinGrace: false,
        expectMinChange: true,
        expectMaxChange: false,
      },
      // Backchannel: overlapping + shouldIgnore outside grace → skip
      {
        label: 'agent_active/overlap/ignore/outside_grace',
        agentSpeech: 'active',
        overlapping: true,
        shouldIgnore: true,
        withinGrace: false,
        expectMinChange: false,
        expectMaxChange: false,
      },
      // Grace period override: overlapping + shouldIgnore inside grace → case 2 still runs
      {
        label: 'agent_active/overlap/ignore/inside_grace',
        agentSpeech: 'active',
        overlapping: true,
        shouldIgnore: true,
        withinGrace: true,
        expectMinChange: true,
        expectMaxChange: false,
      },
    ];

    it.each(cases)(
      '$label',
      ({
        label,
        agentSpeech,
        overlapping,
        shouldIgnore,
        withinGrace,
        expectMinChange,
        expectMaxChange,
      }) => {
        const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

        // Previous utterance
        ep.onStartOfSpeech(99000);
        ep.onEndOfSpeech(100000);

        // Set up agent speech state
        let userStart: number;
        if (agentSpeech === 'ended') {
          ep.onStartOfAgentSpeech(100500);
          ep.onEndOfAgentSpeech(101000);
          userStart = 101500;
        } else if (agentSpeech === 'active') {
          if (withinGrace) {
            // Agent at 100150, user at 100350 (200ms after agent, within 250ms grace)
            // betweenTurnDelay=150, betweenUtteranceDelay=350
            // interruptionDelay=|350-150|=200 <= 300 → case 2 triggers
            // EMA: 0.5*350 + 0.5*300 = 325 → min changes
            ep.onStartOfAgentSpeech(100150);
            userStart = 100350;
          } else if (overlapping && shouldIgnore) {
            // Outside grace: agent at 100200, user at 101500 (1.3s after agent)
            // shouldIgnore + overlapping + outside grace → skip
            ep.onStartOfAgentSpeech(100200);
            userStart = 101500;
          } else if (overlapping) {
            // Agent at 100150, user at 100400 (250ms after agent, at grace boundary)
            // betweenTurnDelay=150, betweenUtteranceDelay=400
            // interruptionDelay=|400-150|=250 <= 300 → case 2 triggers
            // EMA: 0.5*400 + 0.5*300 = 350 → min changes
            ep.onStartOfAgentSpeech(100150);
            userStart = 100400;
          } else {
            // Delayed: agent spoke but user starts much later (inferred interruption)
            // betweenTurnDelay=900 → case 3 updates maxDelay
            ep.onStartOfAgentSpeech(100900);
            userStart = 101800;
          }
        } else {
          // No agent speech
          userStart = 100400;
        }

        ep.onStartOfSpeech(userStart, overlapping);

        const prevMin = ep.minDelay;
        const prevMax = ep.maxDelay;

        ep.onEndOfSpeech(userStart + 500, shouldIgnore);

        const minChanged = ep.minDelay !== prevMin;
        const maxChanged = ep.maxDelay !== prevMax;

        expect(
          minChanged,
          `[${label}] minDelay change mismatch: ${prevMin} -> ${ep.minDelay}`,
        ).toBe(expectMinChange);
        expect(
          maxChanged,
          `[${label}] maxDelay change mismatch: ${prevMax} -> ${ep.maxDelay}`,
        ).toBe(expectMaxChange);

        // State should always be cleaned up after onEndOfSpeech
        const any = peek(ep);
        expect(any._speaking, `[${label}] _speaking should be false`).toBe(false);
        expect(any._overlapping, `[${label}] _overlapping should be false`).toBe(false);
      },
    );
  });

  // Ref: python tests/test_endpointing.py - 511-545 lines
  it('test_full_conversation_sequence', () => {
    const ep = new DynamicEndpointing({ minDelay: 300, maxDelay: 1000, alpha: 0.5 });

    // Turn 1: user speaks
    ep.onStartOfSpeech(100000);
    ep.onEndOfSpeech(101000);

    // Agent responds
    ep.onStartOfAgentSpeech(101500);

    // Turn 2: user backchannel (ignored) — overlapping with agent, 1.0s after agent start
    ep.onStartOfSpeech(102500, true);
    const minBefore = ep.minDelay;
    const maxBefore = ep.maxDelay;
    ep.onEndOfSpeech(102800, true);

    // backchannel ignored — delays unchanged
    expect(ep.minDelay).toBe(minBefore);
    expect(ep.maxDelay).toBe(maxBefore);

    // Agent finishes
    ep.onEndOfAgentSpeech(103000);

    // Turn 3: user speaks again (new turn after agent)
    ep.onStartOfSpeech(103500);
    ep.onEndOfSpeech(104000);

    const any = peek(ep);
    expect(any._speaking).toBe(false);
    expect(any._agentSpeechStartedAt).toBeUndefined();
  });
});

// Target-only coverage for the integration seam between DynamicEndpointing and target-only
// runtime paths (createEndpointing factory, AudioRecognition.updateOptions replacement).
describe('createEndpointing', () => {
  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 305-316 lines
  it('returns BaseEndpointing for fixed mode', () => {
    const ep = createEndpointing({ mode: 'fixed', minDelay: 300, maxDelay: 1000 });
    expect(ep).toBeInstanceOf(BaseEndpointing);
    expect(ep).not.toBeInstanceOf(DynamicEndpointing);
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  it('returns DynamicEndpointing for dynamic mode', () => {
    const ep = createEndpointing({ mode: 'dynamic', minDelay: 300, maxDelay: 1000 });
    expect(ep).toBeInstanceOf(DynamicEndpointing);
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });
});

describe('BaseEndpointing', () => {
  // Ref: python livekit-agents/livekit/agents/voice/endpointing.py - 10-46 lines
  it('updateOptions updates fixed delays without resetting overlap state', () => {
    const ep = new BaseEndpointing({ minDelay: 300, maxDelay: 1000 });
    ep.onStartOfSpeech(100000, true);
    expect(ep.overlapping).toBe(true);

    ep.updateOptions({ minDelay: 500 });
    expect(ep.minDelay).toBe(500);
    expect(ep.maxDelay).toBe(1000);
    // overlap state preserved across updateOptions
    expect(ep.overlapping).toBe(true);

    ep.updateOptions({ maxDelay: 2000 });
    expect(ep.maxDelay).toBe(2000);
    expect(ep.overlapping).toBe(true);

    ep.onEndOfSpeech(100500);
    expect(ep.overlapping).toBe(false);
  });

  it('onStartOfAgentSpeech / onEndOfAgentSpeech are no-ops', () => {
    const ep = new BaseEndpointing({ minDelay: 300, maxDelay: 1000 });
    expect(() => ep.onStartOfAgentSpeech(100000)).not.toThrow();
    expect(() => ep.onEndOfAgentSpeech(100500)).not.toThrow();
    // base impl doesn't track agent speech state
    expect(ep.overlapping).toBe(false);
  });
});
