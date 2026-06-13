// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import type { VAD } from '../vad.js';
import {
  AudioRecognition,
  type AudioRecognitionOptions,
  type RecognitionHooks,
  type TurnDetectionMode,
} from './audio_recognition.js';

/** Private members of AudioRecognition the tests poke at to drive the EOU task. */
interface RecognitionInternals {
  vad?: VAD;
  lastSpeakingTime?: number;
  lastFinalTranscriptTime: number;
  audioTranscript: string;
  finalTranscriptConfidence: number[];
  bounceEOUTask?: {
    result: Promise<void>;
    cancel: () => void;
    cancelAndWait: () => Promise<void>;
  };
  runEOUDetection: (ctx: ChatContext) => void;
}

function makeHooks(): { hooks: RecognitionHooks; onEndOfTurn: ReturnType<typeof vi.fn> } {
  const onEndOfTurn = vi.fn(async () => true);
  const hooks: RecognitionHooks = {
    onInterruption: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onUserTurnExceeded: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn,
  };
  return { hooks, onEndOfTurn };
}

function makeRecognition(opts: {
  turnDetectionMode: TurnDetectionMode;
  minEndpointingDelay: number;
}): {
  recognition: AudioRecognition;
  internals: RecognitionInternals;
  onEndOfTurn: ReturnType<typeof vi.fn>;
} {
  const { hooks, onEndOfTurn } = makeHooks();
  const recognitionOpts: AudioRecognitionOptions = {
    recognitionHooks: hooks,
    stt: undefined,
    vad: undefined,
    interruptionDetection: undefined,
    turnDetectionMode: opts.turnDetectionMode,
    minEndpointingDelay: opts.minEndpointingDelay,
    maxEndpointingDelay: opts.minEndpointingDelay,
    getLinkedParticipant: () => ({ sid: 'p1', identity: 'bob', kind: ParticipantKind.AGENT }),
  };
  const recognition = new AudioRecognition(recognitionOpts);
  return {
    recognition,
    internals: recognition as unknown as RecognitionInternals,
    onEndOfTurn,
  };
}

describe('AudioRecognition bounceEOUTask endpointing delay (#1741)', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('VAD mode: minEndpointingDelay survives end-of-speech silence (regression for #1741)', async () => {
    // Repro: Silero's minSilenceDuration (~550 ms) has already elapsed by
    // the time bounceEOUTask is invoked at VAD END_OF_SPEECH. Before the
    // fix, `extraSleep += lastSpeakingTime - Date.now()` collapsed the
    // post-EOS window to (minDelay − elapsedSilence) ≈ −250 ms with the
    // values below — so the turn committed the instant END_OF_SPEECH
    // fired and any mid-sentence pause split into two segments.
    const minDelay = 300;
    const elapsedSilence = 550;

    const { internals, onEndOfTurn } = makeRecognition({
      turnDetectionMode: 'vad',
      minEndpointingDelay: minDelay,
    });
    // VAD must be truthy for vadBaseTurnDetection to take the fix branch.
    internals.vad = {} as VAD;
    internals.lastSpeakingTime = Date.now() - elapsedSilence;
    internals.lastFinalTranscriptTime = 0;
    internals.audioTranscript = '';
    internals.finalTranscriptConfidence = [];

    const start = Date.now();
    internals.runEOUDetection(ChatContext.empty());
    // Wait for the task to settle.
    await internals.bounceEOUTask!.result.catch(() => {});
    const elapsed = Date.now() - start;

    expect(onEndOfTurn).toHaveBeenCalledTimes(1);
    // The post-EOS grouping window must be roughly the configured minDelay,
    // independent of how long Silero waited before emitting END_OF_SPEECH.
    // Allow generous slack for timer scheduling jitter.
    expect(elapsed).toBeGreaterThanOrEqual(minDelay - 50);
    expect(elapsed).toBeLessThan(minDelay + 250);
  }, 10_000);

  it('STT mode: endpointing delay still compensates for transcription latency', async () => {
    // STT mode's adjustment is intentional — bounceEOUTask runs from STT's
    // INFERENCE_DONE event, so subtracting elapsed time keeps the post-
    // speech window roughly `minDelay` long even when transcription took
    // a while. This test guards the fix from regressing STT-mode behaviour.
    const minDelay = 400;
    const elapsedSinceSpeech = 150;

    const { internals, onEndOfTurn } = makeRecognition({
      turnDetectionMode: 'stt',
      minEndpointingDelay: minDelay,
    });
    // No VAD — STT mode path. (vad undefined keeps vadBaseTurnDetection false.)
    internals.vad = undefined;
    internals.lastSpeakingTime = Date.now() - elapsedSinceSpeech;
    internals.lastFinalTranscriptTime = 0;
    internals.audioTranscript = '';
    internals.finalTranscriptConfidence = [];

    const start = Date.now();
    internals.runEOUDetection(ChatContext.empty());
    await internals.bounceEOUTask!.result.catch(() => {});
    const elapsed = Date.now() - start;

    const expected = minDelay - elapsedSinceSpeech;
    expect(onEndOfTurn).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(expected - 50);
    expect(elapsed).toBeLessThan(expected + 250);
  }, 10_000);
});
