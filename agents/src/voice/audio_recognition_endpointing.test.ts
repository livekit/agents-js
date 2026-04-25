// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { DynamicEndpointing, createEndpointing } from './endpointing.js';

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
  it('tracks agent speech timestamps even when adaptive interruption detection is disabled', async () => {
    const endpointing = new DynamicEndpointing(300, 1000);
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing,
    });

    try {
      await recognition.onStartOfAgentSpeech(100_500);
      expect((endpointing as any)._agent_speech_started_at).toBe(100_500);

      await recognition.onEndOfAgentSpeech(101_000);
      expect((endpointing as any)._agent_speech_ended_at).toBeDefined();
    } finally {
      await recognition.close();
    }
  });

  it('replaces the endpointing strategy on updateOptions instead of preserving learned state', async () => {
    const original = new DynamicEndpointing(300, 1000, 0.5);
    original.onEndOfSpeech(100_000);
    original.onStartOfSpeech(100_400);
    original.onEndOfSpeech(100_500);
    expect(original.minDelay).toBeCloseTo(350, 5);

    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing: original,
    });
    const replacement = createEndpointing({ mode: 'dynamic', minDelay: 600, maxDelay: 2000 });

    try {
      recognition.updateOptions({ endpointing: replacement, turnDetection: undefined });

      expect((recognition as any).endpointing).toBe(replacement);
      expect(((recognition as any).endpointing as DynamicEndpointing).minDelay).toBe(600);
    } finally {
      await recognition.close();
    }
  });
});
