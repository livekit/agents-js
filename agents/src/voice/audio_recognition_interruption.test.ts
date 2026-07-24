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
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async () => true),
  };
}

function createRecognitionInternals(opts: {
  ignoreUntil: number;
  agentStarted?: number;
  inputStarted: number;
}) {
  const recognition = new AudioRecognition({
    recognitionHooks: createHooks(),
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
  }) as unknown as {
    isInterruptionEnabled: boolean;
    ignoreUserTranscriptUntil: number;
    agentSpeechStartedAt?: number;
    sttPipeline: { inputStartedAt: number };
    shouldHoldSttEvent: (ev: SpeechEvent) => boolean;
  };

  recognition.isInterruptionEnabled = true;
  recognition.ignoreUserTranscriptUntil = opts.ignoreUntil;
  recognition.agentSpeechStartedAt = opts.agentStarted;
  recognition.sttPipeline = { inputStartedAt: opts.inputStarted };
  return recognition;
}

function finalTranscript(startTime: number, endTime: number): SpeechEvent {
  return {
    type: SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [{ text: 'hi', startTime, endTime, confidence: 1 }],
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

  it('holds transcripts inside the bounded ignore window', () => {
    const recognition = createRecognitionInternals({
      ignoreUntil: 1_010_000,
      agentStarted: 1_005_000,
      inputStarted: 1_000_000,
    });

    expect(recognition.shouldHoldSttEvent(finalTranscript(7, 8))).toBe(true);
  });

  it('does not hold timestamps anchored before agent speech', () => {
    const recognition = createRecognitionInternals({
      ignoreUntil: 1_010_000,
      agentStarted: 1_005_000,
      inputStarted: 1_000_000,
    });

    expect(recognition.shouldHoldSttEvent(finalTranscript(2, 3))).toBe(false);
  });

  it('does not hold timestamps after the ignore cutoff', () => {
    const recognition = createRecognitionInternals({
      ignoreUntil: 1_010_000,
      agentStarted: 1_005_000,
      inputStarted: 1_000_000,
    });

    expect(recognition.shouldHoldSttEvent(finalTranscript(15, 16))).toBe(false);
  });

  it('does not hold timestamps in the future', () => {
    const now = Date.now();
    const recognition = createRecognitionInternals({
      ignoreUntil: now + 100_000,
      agentStarted: now - 1_000,
      inputStarted: now,
    });

    expect(recognition.shouldHoldSttEvent(finalTranscript(200, 201))).toBe(false);
  });

  it('uses agent speech start as the lower bound across multiple overlaps', () => {
    const recognition = createRecognitionInternals({
      ignoreUntil: 1_010_000,
      agentStarted: 1_005_000,
      inputStarted: 1_000_000,
    });

    expect(recognition.shouldHoldSttEvent(finalTranscript(6, 6.5))).toBe(true);
    expect(recognition.shouldHoldSttEvent(finalTranscript(8, 8.5))).toBe(true);
  });
});
