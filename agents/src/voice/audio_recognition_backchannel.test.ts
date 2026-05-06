// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import {
  AudioRecognition,
  type AudioRecognitionOptions,
  type RecognitionHooks,
} from './audio_recognition.js';

function createHooks(): RecognitionHooks {
  return {
    onInterruption: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async () => true),
  };
}

function createRecognition(overrides: Partial<AudioRecognitionOptions> = {}): AudioRecognition {
  return new AudioRecognition({
    recognitionHooks: createHooks(),
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
    ...overrides,
  });
}

describe('AudioRecognition backchannel boundary', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('option normalization', () => {
    it('accepts a single number and applies it to the start side', async () => {
      const ar = createRecognition({ backchannelBoundary: 250 });
      const cb = vi.fn();

      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb;
      expect(ar.backchannelBoundaryActive).toBe(true);

      vi.advanceTimersByTime(249);
      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(ar.backchannelBoundaryActive).toBe(false);

      await ar.close();
    });

    it('accepts a [start, end] tuple and uses the start value for the start timer', async () => {
      const ar = createRecognition({ backchannelBoundary: [100, 999] });
      const cb = vi.fn();

      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb;

      vi.advanceTimersByTime(99);
      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledTimes(1);

      await ar.close();
    });

    it('disables both sides cleanly when set to null', async () => {
      const ar = createRecognition({ backchannelBoundary: null });
      const cb = vi.fn();

      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb;
      expect(ar.backchannelBoundaryActive).toBe(false);

      vi.advanceTimersByTime(60_000);
      expect(cb).not.toHaveBeenCalled();

      await ar.close();
    });

    it('disables both sides cleanly when undefined', async () => {
      const ar = createRecognition();

      await ar.onStartOfAgentSpeech();
      expect(ar.backchannelBoundaryActive).toBe(false);

      await ar.close();
    });

    it('does not arm the start timer when start cooldown is 0', async () => {
      const ar = createRecognition({ backchannelBoundary: [0, 500] });
      const cb = vi.fn();

      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb;
      expect(ar.backchannelBoundaryActive).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(cb).not.toHaveBeenCalled();

      await ar.close();
    });

    it('throws on a negative single number', () => {
      expect(() => createRecognition({ backchannelBoundary: -1 })).toThrow(/non-negative number/);
    });

    it('throws on a tuple with a negative element', () => {
      expect(() => createRecognition({ backchannelBoundary: [100, -1] })).toThrow(
        /non-negative numbers/,
      );
    });
  });

  describe('lifecycle', () => {
    it('re-arms the start cooldown when onStartOfAgentSpeech is called again', async () => {
      // Models the false-interruption resume path: the agent is paused and resumed,
      // so AgentActivity calls onStartOfAgentSpeech() a second time.
      const ar = createRecognition({ backchannelBoundary: 200 });
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb1;
      expect(ar.backchannelBoundaryActive).toBe(true);

      vi.advanceTimersByTime(50);
      // resume path -> re-arm the timer 50ms in
      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb2;
      expect(ar.backchannelBoundaryActive).toBe(true);

      // The timer should fire 200ms from the *second* call (250ms total),
      // not 200ms from the first call (which would be 150ms from now).
      vi.advanceTimersByTime(199);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);

      await ar.close();
    });

    it('cancelBackchannelBoundary clears both the timer and the callback', async () => {
      const ar = createRecognition({ backchannelBoundary: 500 });
      const cb = vi.fn();

      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb;
      expect(ar.backchannelBoundaryActive).toBe(true);

      ar.cancelBackchannelBoundary();
      expect(ar.backchannelBoundaryActive).toBe(false);
      expect(ar.backchannelBoundaryCallback).toBeUndefined();

      vi.advanceTimersByTime(1000);
      expect(cb).not.toHaveBeenCalled();

      await ar.close();
    });

    it('onEndOfAgentSpeech cancels a pending start-boundary timer', async () => {
      const ar = createRecognition({ backchannelBoundary: [1000, 500] });
      const cb = vi.fn();

      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb;
      expect(ar.backchannelBoundaryActive).toBe(true);

      await ar.onEndOfAgentSpeech(Date.now() + 1000);
      expect(ar.backchannelBoundaryActive).toBe(false);

      vi.advanceTimersByTime(2000);
      expect(cb).not.toHaveBeenCalled();

      await ar.close();
    });

    it('disableInterruptionDetection() cancels a pending boundary timer', async () => {
      const ar = createRecognition({ backchannelBoundary: 1000 });
      const cb = vi.fn();

      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb;
      expect(ar.backchannelBoundaryActive).toBe(true);

      await ar.disableInterruptionDetection();
      expect(ar.backchannelBoundaryActive).toBe(false);

      vi.advanceTimersByTime(2000);
      expect(cb).not.toHaveBeenCalled();

      await ar.close();
    });

    it('close() cancels a pending boundary timer (no leak on shutdown)', async () => {
      const ar = createRecognition({ backchannelBoundary: 1000 });
      const cb = vi.fn();

      await ar.onStartOfAgentSpeech();
      ar.backchannelBoundaryCallback = cb;
      expect(ar.backchannelBoundaryActive).toBe(true);

      await ar.close();
      expect(ar.backchannelBoundaryActive).toBe(false);

      vi.advanceTimersByTime(2000);
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
