// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import {
  AudioRecognition,
  type RecognitionHooks,
  type _TurnDetector,
} from './audio_recognition.js';
import { DynamicEndpointing } from './endpointing.js';

initializeLogger({ pretty: false, level: 'silent' });

type AudioRecognitionInternals = AudioRecognition & {
  audioTranscript: string;
  lastSpeakingTime?: number;
  lastFinalTranscriptTime: number;
  speechStartTime?: number;
  endpointing: DynamicEndpointing;
  runEOUDetection: (chatCtx: ChatContext) => void;
};

function recognitionInternals(recognition: AudioRecognition): AudioRecognitionInternals {
  return recognition as unknown as AudioRecognitionInternals;
}

function createHooks() {
  const hooks: RecognitionHooks = {
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

  return hooks;
}

function primeRecognition(recognition: AudioRecognition, transcript = 'hello') {
  recognitionInternals(recognition).audioTranscript = transcript;
  recognitionInternals(recognition).lastSpeakingTime = Date.now();
  recognitionInternals(recognition).lastFinalTranscriptTime = Date.now();
  recognitionInternals(recognition).speechStartTime = Date.now() - 500;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AudioRecognition dynamic endpointing integration', () => {
  it('uses learned dynamic minDelay for the default EOU wait', async () => {
    vi.useFakeTimers();

    const hooks = createHooks();
    const endpointing = new DynamicEndpointing(300, 1000, 0.5);
    endpointing.onEndOfSpeech(100000);
    endpointing.onStartOfSpeech(100400);
    endpointing.onEndOfSpeech(100600);

    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
      endpointing,
    });

    try {
      primeRecognition(recognition);
      recognitionInternals(recognition).runEOUDetection(ChatContext.empty());

      await vi.advanceTimersByTimeAsync(349);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
    } finally {
      await recognition.close();
    }
  });

  it('uses learned dynamic maxDelay when the turn detector requests the unlikely path', async () => {
    vi.useFakeTimers();

    const hooks = createHooks();
    const endpointing = new DynamicEndpointing(300, 1000, 0.5);
    endpointing.onEndOfSpeech(100000);
    endpointing.onStartOfAgentSpeech(100900);
    endpointing.onStartOfSpeech(101800);
    endpointing.onEndOfSpeech(102000);

    const turnDetector: _TurnDetector = {
      model: 'fake-turn-detector',
      provider: 'test',
      supportsLanguage: async () => true,
      unlikelyThreshold: async () => 0.5,
      predictEndOfTurn: async () => 0.1,
    };

    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
      endpointing,
      turnDetector,
      turnDetectionMode: turnDetector,
    });

    try {
      primeRecognition(recognition);
      recognitionInternals(recognition).runEOUDetection(ChatContext.empty());

      await vi.advanceTimersByTimeAsync(949);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
    } finally {
      await recognition.close();
    }
  });

  it('replaces the endpointing strategy on updateOptions instead of preserving learned state', async () => {
    vi.useFakeTimers();

    const hooks = createHooks();
    const learnedEndpointing = new DynamicEndpointing(300, 1000, 0.5);
    learnedEndpointing.onEndOfSpeech(100000);
    learnedEndpointing.onStartOfSpeech(100400);
    learnedEndpointing.onEndOfSpeech(100600);

    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
      endpointing: learnedEndpointing,
    });

    try {
      recognition.updateOptions({
        endpointing: new DynamicEndpointing(300, 1000, 0.5),
        turnDetection: undefined,
      });

      primeRecognition(recognition);
      recognitionInternals(recognition).runEOUDetection(ChatContext.empty());

      await vi.advanceTimersByTimeAsync(299);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
      expect(recognitionInternals(recognition).endpointing.minDelay).toBe(300);
    } finally {
      await recognition.close();
    }
  });
});
