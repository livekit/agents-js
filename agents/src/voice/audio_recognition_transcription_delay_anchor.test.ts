// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import type { VAD } from '../vad.js';
import {
  AudioRecognition,
  type RecognitionHooks,
  _computeEndOfTurnMetrics,
} from './audio_recognition.js';
import type { TurnDetectionMode } from './turn_config/index.js';

interface RecognitionInternals {
  lastFinalTranscriptTime: number;
  lastSpeakingTime?: number;
  speaking: boolean;
  sttPipeline: { inputStartedAt: number };
  userTurnCommitted: boolean;
  onSTTEvent: (event: SpeechEvent) => Promise<void>;
  runEOUDetection: () => void;
}

function makeHooks(): RecognitionHooks {
  return {
    onInterruption: vi.fn(),
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onTranscriptionTimeout: vi.fn(),
    onEndOfTurn: vi.fn(async () => true),
    onEotPrediction: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onUserTurnExceeded: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
  };
}

function makeRecognition({
  vad,
  inputStartedAt,
  mode = 'vad',
}: {
  vad?: VAD;
  inputStartedAt: number;
  mode?: TurnDetectionMode;
}) {
  const hooks = makeHooks();
  const recognition = new AudioRecognition({
    recognitionHooks: hooks,
    vad,
    turnDetectionMode: mode,
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
  });
  const internals = recognition as unknown as RecognitionInternals;
  internals.sttPipeline = { inputStartedAt };
  vi.spyOn(internals, 'runEOUDetection').mockImplementation(() => {});
  return { hooks, internals };
}

function speechEvent(type: SpeechEventType, endTime: number, text: string): SpeechEvent {
  return {
    type,
    alternatives: [{ language: 'en', text, confidence: 1, startTime: 0, endTime }],
  };
}

const finalTranscript = (endTime: number) =>
  speechEvent(SpeechEventType.FINAL_TRANSCRIPT, endTime, 'hello there');
const preflightTranscript = (endTime: number) =>
  speechEvent(SpeechEventType.PREFLIGHT_TRANSCRIPT, endTime, 'hello');
const modes: TurnDetectionMode[] = ['vad', 'stt'];

describe('AudioRecognition transcription delay anchor', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => vi.restoreAllMocks());

  it.each(modes)(
    'preserves a wired VAD anchor for an untimestamped transcript in %s mode',
    async (mode) => {
      const now = 20_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { internals } = makeRecognition({
        vad: {} as VAD,
        inputStartedAt: now - 10_000,
        mode,
      });
      internals.lastSpeakingTime = now - 600;

      await internals.onSTTEvent(finalTranscript(0));

      expect(internals.lastSpeakingTime).toBe(now - 600);
      expect(
        _computeEndOfTurnMetrics({
          speechStartTime: now - 3_000,
          lastSpeakingTime: internals.lastSpeakingTime,
          lastFinalTranscriptTime: internals.lastFinalTranscriptTime,
          now,
        }).transcriptionDelay,
      ).toBe(600);
    },
  );

  it.each(modes)('uses a provider timestamp over a VAD anchor only in %s mode', async (mode) => {
    const now = 20_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { internals } = makeRecognition({
      vad: {} as VAD,
      inputStartedAt: now - 10_000,
      mode,
    });
    internals.lastSpeakingTime = now - 600;

    await internals.onSTTEvent(finalTranscript(9));

    expect(internals.lastSpeakingTime).toBe(mode === 'stt' ? now - 1_000 : now - 600);
  });

  it.each(modes)('handles a future provider timestamp in %s mode', async (mode) => {
    const now = 20_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { internals } = makeRecognition({
      vad: {} as VAD,
      inputStartedAt: now - 10_000,
      mode,
    });
    internals.lastSpeakingTime = now - 600;

    await internals.onSTTEvent(finalTranscript(12));

    expect(internals.lastSpeakingTime).toBe(mode === 'stt' ? now : now - 600);
  });

  it.each(modes)(
    'uses a provider timestamp when VAD missed the segment in %s mode',
    async (mode) => {
      const now = 20_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { internals } = makeRecognition({
        vad: {} as VAD,
        inputStartedAt: now - 10_000,
        mode,
      });

      await internals.onSTTEvent(finalTranscript(9.4));

      expect(internals.lastSpeakingTime).toBe(now - 600);
    },
  );

  it.each(modes)('uses a provider timestamp without VAD in %s mode', async (mode) => {
    const now = 40_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { internals } = makeRecognition({ inputStartedAt: now - 10_000, mode });
    internals.lastSpeakingTime = now - 30_000;

    await internals.onSTTEvent(finalTranscript(9.4));

    expect(internals.lastSpeakingTime).toBe(now - 600);
  });

  it.each(modes)(
    'applies the same anchor rules to preflight transcripts in %s mode',
    async (mode) => {
      const now = 20_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const first = makeRecognition({ vad: {} as VAD, inputStartedAt: now - 10_000, mode });
      first.internals.lastSpeakingTime = now - 600;

      await first.internals.onSTTEvent(preflightTranscript(0));
      expect(first.internals.lastSpeakingTime).toBe(now - 600);

      const second = makeRecognition({ vad: {} as VAD, inputStartedAt: now - 10_000, mode });
      second.internals.lastSpeakingTime = now - 600;
      await second.internals.onSTTEvent(preflightTranscript(9));
      expect(second.internals.lastSpeakingTime).toBe(mode === 'stt' ? now - 1_000 : now - 600);
    },
  );

  it('anchors STT end-of-speech on a real provider timestamp', async () => {
    const now = 20_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { internals } = makeRecognition({
      vad: {} as VAD,
      inputStartedAt: now - 10_000,
      mode: 'stt',
    });
    internals.lastSpeakingTime = now - 600;

    await internals.onSTTEvent(speechEvent(SpeechEventType.END_OF_SPEECH, 9, ''));

    expect(internals.lastSpeakingTime).toBe(now - 1_000);
    expect(internals.userTurnCommitted).toBe(true);
  });

  it('prefers the provider speech-end time on STT end-of-speech', async () => {
    const now = 20_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { internals } = makeRecognition({
      vad: {} as VAD,
      inputStartedAt: now - 10_000,
      mode: 'stt',
    });
    internals.lastSpeakingTime = now - 600;

    await internals.onSTTEvent({
      ...speechEvent(SpeechEventType.END_OF_SPEECH, 9, ''),
      speechEndTime: now - 400,
    });

    expect(internals.lastSpeakingTime).toBe(now - 400);
    expect(internals.userTurnCommitted).toBe(true);
  });

  it('clamps a future provider speech-end time on STT end-of-speech', async () => {
    const now = 20_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { internals } = makeRecognition({
      vad: {} as VAD,
      inputStartedAt: now - 10_000,
      mode: 'stt',
    });
    internals.lastSpeakingTime = now - 600;

    await internals.onSTTEvent({
      type: SpeechEventType.END_OF_SPEECH,
      speechEndTime: now + 5_000,
    });

    expect(internals.lastSpeakingTime).toBe(now);
  });

  it('anchors an untimestamped STT end-of-speech on arrival', async () => {
    const now = 20_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { internals } = makeRecognition({
      vad: {} as VAD,
      inputStartedAt: now - 10_000,
      mode: 'stt',
    });
    internals.lastSpeakingTime = now - 600;

    await internals.onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });

    expect(internals.lastSpeakingTime).toBe(now);
    expect(internals.userTurnCommitted).toBe(true);
  });

  it.each(modes)('passes wired VAD speaking state to transcript hooks in %s mode', async (mode) => {
    const now = 20_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const wired = makeRecognition({ vad: {} as VAD, inputStartedAt: now - 10_000, mode });
    wired.internals.speaking = false;

    await wired.internals.onSTTEvent(finalTranscript(0));
    expect(wired.hooks.onFinalTranscript).toHaveBeenCalledWith(expect.anything(), false);

    const withoutVad = makeRecognition({ inputStartedAt: now - 10_000, mode });
    withoutVad.internals.speaking = false;
    await withoutVad.internals.onSTTEvent(finalTranscript(0));
    expect(withoutVad.hooks.onFinalTranscript).toHaveBeenCalledWith(
      expect.anything(),
      mode === 'stt' ? false : undefined,
    );
  });
});
