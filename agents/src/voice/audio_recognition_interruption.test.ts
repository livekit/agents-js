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
    interruptionByAudioActivityEnabled: false,
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
    sttAlignedTranscript: boolean;
    sttPipeline?: { inputStartedAt?: number };
    overlapInCurrentTurn: boolean;
    processSTTEvent: ReturnType<typeof vi.fn>;
    trimHeldTranscripts: (resolvedAt: number, vadSpeechStartedAt?: number) => void;
    flushHeldTranscripts: (resolvedAt?: number, vadSpeechStartedAt?: number) => void;
    onStartOfOverlapSpeech: (
      speechDuration: number,
      startedAt: number,
      userSpeakingSpan?: unknown,
    ) => Promise<boolean>;
    onStartOfAgentSpeech: (startedAt: number) => Promise<void>;
    cancelBackchannelBoundary: () => void;
    trySendInterruptionSentinel: ReturnType<typeof vi.fn>;
    applyOverlapSpeechEvent: (event: OverlappingSpeechEvent) => void;
    onSTTEvent: (event: SpeechEvent) => Promise<void>;
    onEndOfAgentSpeech: (endedAt: number, options?: { paused?: boolean }) => Promise<void>;
    disableInterruptionDetection: () => Promise<void>;
    updateVad: (vad: undefined, usingDefaultVad: boolean) => Promise<void>;
    currentTranscript: string;
    hooks: RecognitionHooks;
  };
}

function transcript(
  text: string,
  options: {
    createdAt: number;
    startTime?: number;
    endTime?: number;
    speechEndTime?: number;
  },
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
    speechEndTime: options.speechEndTime,
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

    recognition.flushHeldTranscripts(10_000, 5_000);

    expect(emittedTexts(recognition.processSTTEvent)).toEqual(['utterance start', 'utterance end']);
  });

  it('does not release transcripts from before agent speech', () => {
    const recognition = createRecognition();
    recognition.agentSpeechStartedAt = 8_000;
    recognition.backchannelBoundary = [0, 1_000];
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [
      transcript('before agent', { createdAt: 7_500 }),
      transcript('during agent', { createdAt: 8_000 }),
    ];
    recognition.processSTTEvent = vi.fn();

    recognition.flushHeldTranscripts(10_000, 5_000);

    expect(emittedTexts(recognition.processSTTEvent)).toEqual(['during agent']);
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

    recognition.flushHeldTranscripts(10_000);

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

    recognition.flushHeldTranscripts(10_000);

    expect(emittedTexts(recognition.processSTTEvent)).toEqual(['recent']);
  });

  it('preserves a delayed transcript from before agent speech', () => {
    const recognition = createRecognition();
    recognition.agentSpeechStartedAt = 8_000;
    recognition.backchannelBoundary = [0, 1_000];
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [
      transcript('prior speech', { createdAt: 8_500, speechEndTime: 7_500 }),
    ];
    recognition.processSTTEvent = vi.fn();

    recognition.flushHeldTranscripts(10_000);

    expect(emittedTexts(recognition.processSTTEvent)).toEqual(['prior speech']);
  });

  it('discards a delayed backchannel using its speech end time', () => {
    const recognition = createRecognition();
    recognition.agentSpeechStartedAt = 8_000;
    recognition.backchannelBoundary = [0, 1_000];
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [
      transcript('backchannel', { createdAt: 9_500, speechEndTime: 8_500 }),
    ];
    recognition.processSTTEvent = vi.fn();

    recognition.flushHeldTranscripts(10_000);

    expect(recognition.processSTTEvent).not.toHaveBeenCalled();
  });

  it('flushes held events in provider order', () => {
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

    recognition.flushHeldTranscripts();

    expect(recognition.processSTTEvent).toHaveBeenCalledTimes(3);
    expect(recognition.processSTTEvent.mock.calls.map(([event]) => event)).toEqual(events);
    expect(recognition.transcriptBuffer).toEqual([]);
    expect(recognition.transcriptGateActive).toBe(false);
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

  it('does not arm the gate for agent speech without overlap', async () => {
    const recognition = createRecognition();
    recognition.isInterruptionEnabled = true;
    recognition.transcriptGateActive = true;
    recognition.trySendInterruptionSentinel = vi.fn(async () => true);

    await recognition.onStartOfAgentSpeech(5_000);

    expect(recognition.transcriptGateActive).toBe(false);
  });

  it('uses audio activity for the full agent-speech interval after a start-boundary overlap', async () => {
    const recognition = createRecognition();
    recognition.isInterruptionEnabled = true;
    recognition.backchannelBoundary = [1_000, 1_000];
    recognition.trySendInterruptionSentinel = vi.fn(async () => true);

    await recognition.onStartOfAgentSpeech(5_000);
    recognition.cancelBackchannelBoundary();
    await recognition.onStartOfOverlapSpeech(0, 5_500);

    expect(recognition.hooks.interruptionByAudioActivityEnabled).toBe(true);
    expect(recognition.transcriptGateActive).toBe(false);
    expect(recognition.trySendInterruptionSentinel).toHaveBeenCalledOnce();

    await recognition.onStartOfOverlapSpeech(0, 6_500);

    expect(recognition.hooks.interruptionByAudioActivityEnabled).toBe(true);
    expect(recognition.transcriptGateActive).toBe(false);
    expect(recognition.trySendInterruptionSentinel).toHaveBeenCalledOnce();
  });

  it('enables audio activity for an ungated final during agent speech', async () => {
    const recognition = createRecognition();
    recognition.isAgentSpeaking = true;
    recognition.transcriptGateActive = false;

    await recognition.onSTTEvent(transcript('late final', { createdAt: 5_200 }));

    expect(recognition.hooks.interruptionByAudioActivityEnabled).toBe(true);
  });

  it.each([
    { aligned: true, speechEndTime: undefined, endTime: 9, expected: 10_000 },
    { aligned: false, speechEndTime: undefined, endTime: 9, expected: undefined },
    { aligned: true, speechEndTime: 8_000, endTime: 9, expected: 8_000 },
    { aligned: true, speechEndTime: undefined, endTime: 11, expected: undefined },
  ])(
    'normalizes aligned speech timing after a custom STT node: $aligned, $speechEndTime, $endTime',
    async ({ aligned, speechEndTime, endTime, expected }) => {
      const recognition = createRecognition();
      recognition.sttAlignedTranscript = aligned;
      recognition.sttPipeline = { inputStartedAt: 1_000 };
      recognition.isAgentSpeaking = true;
      recognition.transcriptGateActive = true;

      await recognition.onSTTEvent(
        transcript('custom', { createdAt: 11_000, endTime, speechEndTime }),
      );

      expect(recognition.transcriptBuffer[0]?.speechEndTime).toBe(expected);
    },
  );

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

  it('flushes the gate when adaptive interruption is disabled', async () => {
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

  it('flushes held transcripts when VAD is disabled', async () => {
    const recognition = createRecognition();
    const event = transcript('held', { createdAt: 5_000 });
    recognition.isInterruptionEnabled = true;
    recognition.transcriptGateActive = true;
    recognition.transcriptBuffer = [event];
    recognition.processSTTEvent = vi.fn();

    await recognition.updateVad(undefined, false);

    expect(recognition.processSTTEvent).toHaveBeenCalledWith(event);
    expect(recognition.transcriptGateActive).toBe(false);
    expect(recognition.transcriptBuffer).toEqual([]);
  });

  it('tears down recognition state before detector completion', async () => {
    const recognition = createRecognition();
    recognition.isInterruptionEnabled = true;
    await recognition.onStartOfAgentSpeech(9_000);
    recognition.activeVadSpeechStartedAt = 9_500;
    recognition.transcriptGateActive = true;
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
