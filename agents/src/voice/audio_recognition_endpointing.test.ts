// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { DynamicEndpointing } from './turn_config/endpointing.js';

const ms = (seconds: number) => seconds * 1000;

type RecognitionState = {
  speaking: boolean;
};

type EndpointingState = {
  utteranceStartedAt?: number;
  utteranceEndedAt?: number;
};

function markSpeaking(recognition: AudioRecognition): void {
  (recognition as unknown as RecognitionState).speaking = true;
}

function endpointingState(endpointing: DynamicEndpointing): EndpointingState {
  return endpointing as unknown as EndpointingState;
}

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

describe('AudioRecognition endpointing integration', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('updates dynamic endpointing from recognition speech lifecycle', () => {
    const endpointing = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing,
    });

    recognition.onStartOfSpeech(ms(99.0));
    markSpeaking(recognition);
    recognition.onEndOfSpeech(ms(100.0));
    recognition.onStartOfSpeech(ms(100.4));
    markSpeaking(recognition);
    recognition.onEndOfSpeech(ms(100.6));

    expect(endpointing.minDelay).toBeCloseTo(ms(0.35), 5);
  });

  it('replaces endpointing state through updateOptions', () => {
    const endpointing = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing,
    });

    recognition.onStartOfSpeech(ms(99.0));
    markSpeaking(recognition);
    recognition.onEndOfSpeech(ms(100.0));
    recognition.onStartOfSpeech(ms(100.4));
    markSpeaking(recognition);
    recognition.onEndOfSpeech(ms(100.6));
    expect(endpointing.minDelay).toBeCloseTo(ms(0.35), 5);

    const replacement = new DynamicEndpointing(ms(0.4), ms(1.2), 0.5);
    recognition.updateOptions({ endpointing: replacement });

    expect(recognition.endpointing).toBe(replacement);
    expect(recognition.endpointing.minDelay).toBe(ms(0.4));
    expect(endpointing.minDelay).toBeCloseTo(ms(0.35), 5);
  });

  it('passes false adaptive interruption results to shouldIgnore', () => {
    const endpointing = new DynamicEndpointing(ms(0.3), ms(1.0), 0.5);
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing,
    });

    recognition.onEndOfSpeech(ms(100.0));
    recognition.onStartOfAgentSpeech(ms(100.5));
    recognition.onStartOfSpeech(ms(101.5));
    markSpeaking(recognition);

    const prevMin = endpointing.minDelay;
    const prevMax = endpointing.maxDelay;
    recognition.onEndOfSpeech(ms(101.8), undefined, false);

    expect(endpointing.minDelay).toBe(prevMin);
    expect(endpointing.maxDelay).toBe(prevMax);
    expect(endpointingState(endpointing).utteranceStartedAt).toBeUndefined();
    expect(endpointingState(endpointing).utteranceEndedAt).toBeUndefined();
  });
});
