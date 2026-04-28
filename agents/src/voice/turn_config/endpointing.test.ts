// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../../llm/chat_context.js';
import { initializeLogger } from '../../log.js';
import { ExpFilter } from '../../utils.js';
import { AudioRecognition, type RecognitionHooks } from '../audio_recognition.js';
import { BaseEndpointing, DynamicEndpointing, createEndpointing } from './endpointing.js';

const approx = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 5);

function createHooks(): RecognitionHooks {
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

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ExpFilter', () => {
  it('initializes with valid alpha', () => {
    const ema = new ExpFilter(0.5);
    expect(ema.value).toBeUndefined();

    const emaWithInitial = new ExpFilter(0.5, undefined, undefined, 10.0);
    expect(emaWithInitial.value).toBe(10.0);

    const alphaOne = new ExpFilter(1.0);
    expect(alphaOne.value).toBeUndefined();
  });

  it('rejects invalid alpha values', () => {
    expect(() => new ExpFilter(0.0)).toThrow(/alpha must be in/);
    expect(() => new ExpFilter(-0.5)).toThrow(/alpha must be in/);
    expect(() => new ExpFilter(1.5)).toThrow(/alpha must be in/);
  });

  it('sets the first update directly when there is no initial value', () => {
    const ema = new ExpFilter(0.5);
    const result = ema.apply(1.0, 10.0);
    expect(result).toBe(10.0);
    expect(ema.value).toBe(10.0);
  });

  it('applies EMA formula when an initial value exists', () => {
    const ema = new ExpFilter(0.5, undefined, undefined, 10.0);
    const result = ema.apply(1.0, 20.0);
    expect(result).toBe(15.0);
    expect(ema.value).toBe(15.0);
  });

  it('calculates multiple updates correctly', () => {
    const ema = new ExpFilter(0.5, undefined, undefined, 10.0);
    ema.apply(1.0, 20.0);
    ema.apply(1.0, 20.0);
    expect(ema.value).toBe(17.5);
  });

  it('resets selected filter fields in place', () => {
    const ema = new ExpFilter(0.5, undefined, undefined, 10.0);
    expect(ema.value).toBe(10.0);
    ema.reset();
    expect(ema.value).toBe(10.0);

    const emaWithReset = new ExpFilter(0.5, undefined, undefined, 10.0);
    emaWithReset.reset(undefined, 5.0);
    expect(emaWithReset.value).toBe(5.0);
  });
});

describe('DynamicEndpointing', () => {
  it('initializes with min and max delay', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  it('initializes with custom alpha', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.2);
    expect(ep.minDelay).toBe(300);
    expect(ep.maxDelay).toBe(1000);
  });

  it('uses the updated default alpha', () => {
    const ep = new DynamicEndpointing(300, 1000);
    approx((ep as any)._utterancePause._alpha, 0.9);
    approx((ep as any)._turnPause._alpha, 0.9);
  });

  it('returns empty delays before speech is recorded', () => {
    const ep = new DynamicEndpointing(300, 1000);
    expect(ep.betweenUtteranceDelay).toBe(0.0);
    expect(ep.betweenTurnDelay).toBe(0.0);
    expect(ep.immediateInterruptionDelay).toEqual([0.0, 0.0]);
  });

  it('records utterance end timestamps', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    expect((ep as any)._utteranceEndedAt).toBe(100000);

    const second = new DynamicEndpointing(300, 1000);
    second.onEndOfSpeech(99900);
    expect((second as any)._utteranceEndedAt).toBe(99900);
  });

  it('records utterance start timestamps', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfSpeech(100000);
    expect((ep as any)._utteranceStartedAt).toBe(100000);
  });

  it('records agent speech start timestamps', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onStartOfAgentSpeech(100000);
    expect((ep as any)._agentSpeechStartedAt).toBe(100000);
  });

  it('calculates delay between utterances', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100500);
    approx(ep.betweenUtteranceDelay, 500);
  });

  it('calculates delay between turns', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100800);
    approx(ep.betweenTurnDelay, 800);
  });

  it('updates min delay for pauses between utterances', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100400);
    ep.onEndOfSpeech(100500, false);

    approx(ep.minDelay, 0.5 * 400 + 0.5 * initialMin);
  });

  it('updates max delay for new turns', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100600);
    ep.onStartOfSpeech(101500);
    ep.onEndOfSpeech(102000, false);

    approx(ep.maxDelay, 0.5 * 600 + 0.5 * 1000);
  });

  it('updates min delay for immediate interruptions', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);

    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100200);
    expect((ep as any)._agentSpeechStartedAt).not.toBeUndefined();
    ep.onStartOfSpeech(100250, true);
    expect((ep as any)._overlapping).toBe(true);

    ep.onEndOfSpeech(100500);

    expect((ep as any)._overlapping).toBe(false);
    expect((ep as any)._agentSpeechStartedAt).toBeUndefined();
    approx(ep.minDelay, 300);
  });

  it('updates options', () => {
    const minOnly = new DynamicEndpointing(300, 1000);
    minOnly.updateOptions({ minDelay: 500 });
    expect(minOnly.minDelay).toBe(500);
    expect((minOnly as any)._minDelay).toBe(500);

    const maxOnly = new DynamicEndpointing(300, 1000);
    maxOnly.updateOptions({ maxDelay: 2000 });
    expect(maxOnly.maxDelay).toBe(2000);
    expect((maxOnly as any)._maxDelay).toBe(2000);

    const both = new DynamicEndpointing(300, 1000);
    both.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect(both.minDelay).toBe(500);
    expect(both.maxDelay).toBe(2000);

    const unchanged = new DynamicEndpointing(300, 1000);
    unchanged.updateOptions();
    expect(unchanged.minDelay).toBe(300);
    expect(unchanged.maxDelay).toBe(1000);
  });

  it('clamps max delay to the configured max', () => {
    const ep = new DynamicEndpointing(300, 1000, 1.0);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(102000);
    ep.onStartOfSpeech(105000);
    expect(ep.maxDelay).toBe(1000);
  });

  it('clamps max delay to at least min delay', () => {
    const ep = new DynamicEndpointing(300, 1000, 1.0);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100100);
    ep.onStartOfSpeech(100500);
    expect(ep.maxDelay).toBeGreaterThanOrEqual((ep as any)._minDelay);
  });

  it('clears agent speech for non-interruption utterance end', () => {
    const ep = new DynamicEndpointing(300, 1000);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    expect((ep as any)._agentSpeechStartedAt).not.toBeUndefined();

    ep.onStartOfSpeech(102000);
    ep.onEndOfSpeech(103000, false);
    expect((ep as any)._agentSpeechStartedAt).toBeUndefined();
  });

  it('only tracks the first consecutive interruption', () => {
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

  it('updates max delay for delayed interruptions without crashing', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100900);
    ep.onStartOfSpeech(101800);
    ep.onEndOfSpeech(102000, false);
    approx(ep.maxDelay, 0.5 * 900 + 0.5 * 1000);
  });

  it('adjusts stale utterance end time on interruption', () => {
    const ep = new DynamicEndpointing(60, 1000, 1.0);
    ep.onEndOfSpeech(99000);
    ep.onStartOfSpeech(100000);

    ep.onStartOfAgentSpeech(100200);
    ep.onStartOfSpeech(100250, true);

    expect((ep as any)._utteranceEndedAt).toBe(100199);
    approx(ep.minDelay, 60);
    approx(ep.maxDelay, 1000);
  });

  it('preserves filter alpha when updating delays', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.updateOptions({ minDelay: 600, maxDelay: 2000 });

    approx((ep as any)._utterancePause._alpha, 0.5);
    approx((ep as any)._turnPause._alpha, 0.5);
  });

  it('updates alpha in place without resetting learned state', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100200);
    ep.onEndOfSpeech(101000);
    const learnedMin = ep.minDelay;

    ep.updateOptions({ alpha: 0.2 });

    approx((ep as any)._utterancePause._alpha, 0.2);
    approx((ep as any)._turnPause._alpha, 0.2);
    approx(ep.minDelay, learnedMin);
  });

  it('updates filter clamp bounds', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.updateOptions({ minDelay: 500, maxDelay: 2000 });
    expect((ep as any)._utterancePause._minVal).toBe(500);
    expect((ep as any)._turnPause._maxVal).toBe(2000);

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100200);
    approx(ep.minDelay, 500);

    ep.onEndOfSpeech(101000);
    ep.onStartOfAgentSpeech(102800);
    ep.onStartOfSpeech(103500);
    expect(ep.maxDelay).toBeGreaterThan(1000);
    expect(ep.maxDelay).toBeLessThanOrEqual(2000);
  });

  it('skips filter updates when shouldIgnore is true during overlap', () => {
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

  it('still updates when shouldIgnore is true without overlap', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    const initialMin = ep.minDelay;

    ep.onEndOfSpeech(100000);
    ep.onStartOfSpeech(100400, false);
    ep.onEndOfSpeech(100600, true);

    approx(ep.minDelay, 0.5 * 400 + 0.5 * initialMin);
  });

  it('overrides shouldIgnore within the agent speech grace period', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100500);
    ep.onStartOfSpeech(100600, true);

    ep.onEndOfSpeech(100800, true);

    expect((ep as any)._utteranceEndedAt).toBe(100800);
    expect((ep as any)._speaking).toBe(false);
  });

  it('applies shouldIgnore outside the grace period', () => {
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

  it('sets agent speech ended state and clears overlap', () => {
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

  it('infers overlap from active agent speech', () => {
    const ep = new DynamicEndpointing(300, 1000, 0.5);
    ep.onEndOfSpeech(100000);
    ep.onStartOfAgentSpeech(100900);
    ep.onStartOfSpeech(101800, false);
    ep.onEndOfSpeech(102000);

    approx(ep.maxDelay, 0.5 * 900 + 0.5 * 1000);
  });

  it('sets and clears speaking flag', () => {
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
    'handles overlapping and shouldIgnore combo %s',
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

      expect(ep.minDelay !== prevMin, `[${label}] minDelay change`).toBe(expectMinChange);
      expect(ep.maxDelay !== prevMax, `[${label}] maxDelay change`).toBe(expectMaxChange);
      expect((ep as any)._speaking, `[${label}] _speaking`).toBe(false);
      expect((ep as any)._overlapping, `[${label}] _overlapping`).toBe(false);
    },
  );

  it('handles a full conversation sequence with ignored backchannel', () => {
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

describe('createEndpointing', () => {
  it('wires alpha into dynamic endpointing filters', () => {
    const ep = createEndpointing({ mode: 'dynamic', minDelay: 300, maxDelay: 1000, alpha: 0.7 });

    expect(ep).toBeInstanceOf(DynamicEndpointing);
    approx((ep as any)._utterancePause._alpha, 0.7);
    approx((ep as any)._turnPause._alpha, 0.7);
  });

  it('returns base endpointing for fixed mode', () => {
    const ep = createEndpointing({ mode: 'fixed', minDelay: 500, maxDelay: 3000, alpha: 0.9 });

    expect(ep).not.toBeInstanceOf(DynamicEndpointing);
    expect(ep.minDelay).toBe(500);
    expect(ep.maxDelay).toBe(3000);
  });
});

describe('AudioRecognition endpointing integration', () => {
  it('preserves learned endpointing state when only turn detection changes', () => {
    const endpointing = new DynamicEndpointing(300, 1000, 0.5);
    const recognition = new AudioRecognition({ recognitionHooks: createHooks(), endpointing });

    (recognition as any).speaking = true;
    recognition.onEndOfSpeech(100000);
    recognition.onStartOfSpeech(100400);
    (recognition as any).speaking = true;
    recognition.onEndOfSpeech(100600);
    const learnedMin = endpointing.minDelay;

    recognition.updateOptions({ turnDetection: 'manual' });

    expect((recognition as any).endpointing).toBe(endpointing);
    approx(endpointing.minDelay, learnedMin);
  });

  it('replaces endpointing state only when a new endpointing object is provided', () => {
    const initial = new DynamicEndpointing(300, 1000, 0.5);
    const replacement = new BaseEndpointing(500, 3000);
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing: initial,
    });

    recognition.updateOptions({ endpointing: replacement });

    expect((recognition as any).endpointing).toBe(replacement);
  });

  it('updates endpointing on realtime/no-VAD speech callbacks', () => {
    const endpointing = new DynamicEndpointing(300, 1000, 0.5);
    const recognition = new AudioRecognition({ recognitionHooks: createHooks(), endpointing });

    recognition.onStartOfSpeech(100000, 0);
    (recognition as any).speaking = true;
    recognition.onEndOfSpeech(100500);

    expect((endpointing as any)._utteranceStartedAt).toBe(100000);
    expect((endpointing as any)._utteranceEndedAt).toBe(100500);
  });

  it('updates agent speech endpointing when interruption detection is disabled', async () => {
    vi.useFakeTimers();
    const endpointing = new DynamicEndpointing(300, 1000, 0.5);
    const recognition = new AudioRecognition({ recognitionHooks: createHooks(), endpointing });

    recognition.onStartOfAgentSpeech(100000);
    vi.setSystemTime(101000);
    await recognition.onEndOfAgentSpeech(101000);

    expect((endpointing as any)._agentSpeechStartedAt).toBe(100000);
    expect((endpointing as any)._agentSpeechEndedAt).toBe(101000);
  });
});
