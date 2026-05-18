// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';

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

describe('AudioRecognition interruption buffering', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('does not keep buffering final transcripts after agent speech end begins', async () => {
    const hooks = createHooks();
    hooks.onEndOfTurn = vi.fn(async () => false);
    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
    });

    await recognition.onStartOfAgentSpeech(Date.now());
    const internals = recognition as unknown as {
      isInterruptionEnabled: boolean;
      trySendInterruptionSentinel: () => Promise<boolean>;
      onSTTEvent: (ev: SpeechEvent) => Promise<void>;
      transcriptBuffer: unknown[];
    };
    internals.isInterruptionEnabled = true;
    internals.trySendInterruptionSentinel = vi.fn(() => new Promise<boolean>(() => {}));

    void recognition.onEndOfAgentSpeech(Date.now());
    const finalTranscript: SpeechEvent = {
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text: 'still listening', confidence: 0.9 }],
    };
    await internals.onSTTEvent(finalTranscript);

    expect(hooks.onFinalTranscript).toHaveBeenCalledTimes(1);
    expect(recognition.currentTranscript).toBe('still listening');
    expect(internals.transcriptBuffer).toHaveLength(0);
  });
});
