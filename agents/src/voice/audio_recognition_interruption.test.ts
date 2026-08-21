// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { OverlappingSpeechEvent } from '../inference/interruption/types.js';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';

function createHooks(): RecognitionHooks {
  return {
    onOverlapSpeech: vi.fn(),
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

function createRecognition() {
  const recognition = new AudioRecognition({
    recognitionHooks: createHooks(),
    turnDetectionMode: 'manual',
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
  });
  return recognition as unknown as {
    isAgentSpeaking: boolean;
    isInterruptionEnabled: boolean;
    agentSpeechStartedAt?: number;
    activeVadSpeechStartedAt?: number;
    backchannelBoundary?: [number, number];
    transcriptGateActive: boolean;
    transcriptBuffer: SpeechEvent[];
    overlapInCurrentTurn: boolean;
    processSTTEvent: ReturnType<typeof vi.fn>;
    transcriptFlushStart: (now: number, vadSpeechStartedAt?: number) => number;
    releaseTranscriptGate: (at: number, vadSpeechStartedAt?: number) => void;
    drainTranscriptGate: () => void;
    onStartOfOverlapSpeech: (
      speechDuration: number,
      startedAt: number,
      userSpeakingSpan?: unknown,
    ) => Promise<boolean>;
    trySendInterruptionSentinel: ReturnType<typeof vi.fn>;
    applyOverlapSpeechEvent: (event: OverlappingSpeechEvent) => void;
    onSTTEvent: (event: SpeechEvent) => Promise<void>;
    onEndOfAgentSpeech: (endedAt: number, options?: { paused?: boolean }) => Promise<void>;
    disableInterruptionDetection: () => Promise<void>;
    currentTranscript: string;
    hooks: RecognitionHooks;
  };
}

function transcript(
  text: string,
  options: { createdAt: number; startTime?: number; endTime?: number },
): SpeechEvent {
  return {
    type: SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [
      {
        language: 'en',
        text,
        startTime: options.startTime ?? 0,
        endTime: options.endTime ?? 0,
        confidence: 1,
      },
    ],
    createdAt: options.createdAt,
  };
}

function emittedTexts(processSTTEvent: ReturnType<typeof vi.fn>): string[] {
  return processSTTEvent.mock.calls.map(([event]: [SpeechEvent]) => event.alternatives![0].text);
}

describe('AudioRecognition adaptive transcript gate', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('keeps the active VAD utterance past the end boundary', () => {
    const recognition = createRecognition();
    recognition.agentSpeechStartedAt = undefined;
    recognition.activeVadSpeechStartedAt = 5_000;
    recognition.backchannelBoundary = [0, 1_000];
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [
      transcript('before', { createdAt: 4_000 }),
      transcript('utterance start', { createdAt: 5_000 }),
      transcript('utterance end', { createdAt: 9_500 }),
    ];
    recognition.processSTTEvent = vi.fn();

    const flushStart = recognition.transcriptFlushStart(10_000, 5_000);
    recognition.releaseTranscriptGate(10_000, 5_000);

    expect(flushStart).toBe(5_000);
    expect(emittedTexts(recognition.processSTTEvent)).toEqual(['utterance start', 'utterance end']);
  });

  it('does not release transcripts from before agent speech', () => {
    const recognition = createRecognition();
    recognition.agentSpeechStartedAt = 8_000;
    recognition.backchannelBoundary = [0, 1_000];

    expect(recognition.transcriptFlushStart(10_000, 5_000)).toBe(8_000);
  });

  it('uses the end boundary when no VAD utterance is active', () => {
    const recognition = createRecognition();
    recognition.agentSpeechStartedAt = undefined;
    recognition.backchannelBoundary = [0, 1_000];
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [
      transcript('old', { createdAt: 8_000 }),
      transcript('near end', { createdAt: 9_500 }),
    ];
    recognition.processSTTEvent = vi.fn();

    recognition.releaseTranscriptGate(10_000);

    expect(emittedTexts(recognition.processSTTEvent)).toEqual(['near end']);
    expect(recognition.transcriptBuffer).toEqual([]);
  });

  it('uses local event time instead of provider timestamps', () => {
    const recognition = createRecognition();
    recognition.agentSpeechStartedAt = undefined;
    recognition.backchannelBoundary = [0, 1_000];
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [
      transcript('stale', { createdAt: 8_000, startTime: 10_000, endTime: 20_000 }),
      transcript('recent', { createdAt: 9_500 }),
    ];
    recognition.processSTTEvent = vi.fn();

    recognition.releaseTranscriptGate(10_000);

    expect(emittedTexts(recognition.processSTTEvent)).toEqual(['recent']);
  });

  it('drains held events in provider order', () => {
    const recognition = createRecognition();
    const events: SpeechEvent[] = [
      {
        type: SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives: [
          { language: 'en', text: 'interim', startTime: 0, endTime: 0, confidence: 1 },
        ],
        createdAt: 5_000,
      },
      transcript('final', { createdAt: 5_100 }),
      { type: SpeechEventType.END_OF_SPEECH, createdAt: 5_200 },
    ];
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [...events];
    recognition.processSTTEvent = vi.fn();

    recognition.drainTranscriptGate();

    expect(recognition.processSTTEvent).toHaveBeenCalledTimes(3);
    expect(recognition.processSTTEvent.mock.calls.map(([event]) => event)).toEqual(events);
    expect(recognition.transcriptBuffer).toEqual([]);
  });

  it('rearms the gate for a new overlap after an earlier release', async () => {
    const recognition = createRecognition();
    recognition.isAgentSpeaking = true;
    recognition.isInterruptionEnabled = true;
    recognition.transcriptGateActive = false;
    recognition.trySendInterruptionSentinel = vi.fn(async () => true);

    await recognition.onStartOfOverlapSpeech(0, 6_000);

    expect(recognition.transcriptGateActive).toBe(true);
    expect(recognition.trySendInterruptionSentinel).toHaveBeenCalledOnce();
  });

  it('releases held and later transcripts after a positive verdict', async () => {
    const recognition = createRecognition();
    recognition.isAgentSpeaking = true;
    recognition.agentSpeechStartedAt = 9_000;
    recognition.overlapInCurrentTurn = true;
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [transcript('already held', { createdAt: 9_500 })];

    recognition.applyOverlapSpeechEvent({
      type: 'overlapping_speech',
      detectedAt: 10_000,
      isInterruption: true,
      overlapStartedAt: 9_500,
      totalDurationInS: 0,
      predictionDurationInS: 0,
      detectionDelayInS: 0,
      probability: 1,
      numRequests: 1,
    });
    await recognition.onSTTEvent(transcript('arrived later', { createdAt: 10_100 }));

    const finalTranscriptHook = recognition.hooks.onFinalTranscript as ReturnType<typeof vi.fn>;
    expect(finalTranscriptHook.mock.calls.map(([event]) => event.alternatives![0].text)).toEqual([
      'already held',
      'arrived later',
    ]);
    expect(recognition.currentTranscript).toBe('already held arrived later');
    expect(recognition.transcriptBuffer).toEqual([]);
  });

  it('drains the gate when adaptive interruption is disabled', async () => {
    const recognition = createRecognition();
    const event = transcript('held', { createdAt: 5_000 });
    recognition.isInterruptionEnabled = true;
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [event];
    recognition.processSTTEvent = vi.fn();

    await recognition.disableInterruptionDetection();

    expect(recognition.processSTTEvent).toHaveBeenCalledOnce();
    expect(recognition.processSTTEvent).toHaveBeenCalledWith(event);
    expect(recognition.transcriptGateActive).toBe(false);
    expect(recognition.transcriptBuffer).toEqual([]);
  });

  it('tears down recognition state before detector completion', async () => {
    const recognition = createRecognition();
    recognition.isInterruptionEnabled = true;
    await recognition.onStartOfAgentSpeech(9_000);
    recognition.activeVadSpeechStartedAt = 9_500;
    recognition.transcriptBuffer = [transcript('held', { createdAt: 9_500 })];
    recognition.processSTTEvent = vi.fn();

    let finishDetectorReset!: (inputOpen: boolean) => void;
    recognition.trySendInterruptionSentinel = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishDetectorReset = resolve;
        }),
    );

    const teardown = recognition.onEndOfAgentSpeech(10_000);

    expect(recognition.isAgentSpeaking).toBe(false);
    expect(recognition.agentSpeechStartedAt).toBeUndefined();
    expect(recognition.transcriptGateActive).toBe(false);
    expect(recognition.processSTTEvent).toHaveBeenCalledOnce();

    finishDetectorReset(false);
    await teardown;
  });
});
