// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { DynamicEndpointing } from './endpointing.js';

type AudioRecognitionState = AudioRecognition & {
  _endpointing: DynamicEndpointing;
  speaking: boolean;
};

function state(recognition: AudioRecognition): AudioRecognitionState {
  return recognition as unknown as AudioRecognitionState;
}

initializeLogger({ pretty: false, level: 'silent' });

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

describe('AudioRecognition dynamic endpointing', () => {
  it('applies updated dynamic min delay to subsequent speech callbacks', () => {
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing: new DynamicEndpointing(300, 1000, 0.5),
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
    });

    state(recognition).speaking = true;
    recognition.onStartOfSpeech(99000);
    recognition.onEndOfSpeech(100000);

    state(recognition).speaking = true;
    recognition.onStartOfSpeech(100400);
    recognition.onEndOfSpeech(100900);

    const endpointing = state(recognition)._endpointing;
    expect(endpointing.minDelay).toBeCloseTo(350, 5);
  });

  it('applies dynamic max delay updates from agent-speech interruptions', async () => {
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing: new DynamicEndpointing(300, 1000, 0.5),
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
    });

    state(recognition).speaking = true;
    recognition.onStartOfSpeech(99000);
    recognition.onEndOfSpeech(100000);

    await recognition.onStartOfAgentSpeech(100600);

    state(recognition).speaking = true;
    recognition.onStartOfSpeech(101500);
    recognition.onEndOfSpeech(102000);

    const endpointing = state(recognition)._endpointing;
    expect(endpointing.maxDelay).toBeCloseTo(800, 5);
  });

  it('replaces endpointing state on updateOptions', () => {
    const original = new DynamicEndpointing(300, 1000, 0.5);
    original.onEndOfSpeech(100000);
    original.onStartOfSpeech(100400);
    original.onEndOfSpeech(100500, false);
    expect(original.minDelay).toBeCloseTo(350, 5);

    const replacement = new DynamicEndpointing(500, 2000, 0.5);
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing: original,
      minEndpointingDelay: 300,
      maxEndpointingDelay: 1000,
    });

    recognition.updateOptions({ endpointing: replacement });

    expect(state(recognition)._endpointing).toBe(replacement);
    expect(state(recognition)._endpointing.minDelay).toBe(500);
  });
});
