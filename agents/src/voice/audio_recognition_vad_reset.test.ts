// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import type { VAD, VADStream } from '../vad.js';
import {
  AudioRecognition,
  type AudioRecognitionOptions,
  type RecognitionHooks,
} from './audio_recognition.js';

/** Private members of AudioRecognition the tests poke at to drive the EOS handler. */
interface RecognitionInternals {
  speaking: boolean;
  vadSpeechStarted: boolean;
  vad?: VAD;
  vadStream?: VADStream;
  lastSpeakingTime?: number;
  onSTTEvent: (ev: SpeechEvent) => Promise<void>;
  bounceEOUTask?: { cancelAndWait: () => Promise<void> };
}

function makeHooks(): RecognitionHooks {
  return {
    onInterruption: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    onUserTurnExceeded: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async () => true),
  };
}

function makeRecognition(): { recognition: AudioRecognition; internals: RecognitionInternals } {
  const opts: AudioRecognitionOptions = {
    recognitionHooks: makeHooks(),
    stt: undefined,
    vad: undefined,
    interruptionDetection: undefined,
    turnDetectionMode: 'stt',
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
    getLinkedParticipant: () => ({ sid: 'p1', identity: 'bob', kind: ParticipantKind.AGENT }),
  };
  const recognition = new AudioRecognition(opts);
  return { recognition, internals: recognition as unknown as RecognitionInternals };
}

describe('AudioRecognition STT end-of-speech VAD reset', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('flushes the active VAD stream without restarting VAD', async () => {
    const { recognition, internals } = makeRecognition();
    internals.speaking = true;
    internals.vadSpeechStarted = true;
    internals.vad = {} as VAD;
    const flush = vi.fn();
    const resettableStream = { flush } as unknown as VADStream;
    internals.vadStream = resettableStream;

    const resetVad = vi.spyOn(recognition as never, 'resetVad').mockImplementation(() => {});

    try {
      await internals.onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });

      expect(flush).toHaveBeenCalledTimes(1);
      expect(resetVad).not.toHaveBeenCalled();
      // the existing stream is reused, not torn down
      expect(internals.vadStream).toBe(resettableStream);
    } finally {
      await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
    }
  });

  it('falls back to restarting VAD when there is no active stream', async () => {
    const { recognition, internals } = makeRecognition();
    internals.speaking = true;
    internals.vadSpeechStarted = true;
    internals.vad = {} as VAD;
    internals.vadStream = undefined;

    const resetVad = vi.spyOn(recognition as never, 'resetVad').mockImplementation(() => {});

    try {
      await internals.onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });

      expect(resetVad).toHaveBeenCalledTimes(1);
    } finally {
      await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
    }
  });

  it('preserves the VAD-owned lastSpeakingTime on STT end-of-speech', async () => {
    const { recognition, internals } = makeRecognition();
    // VAD is active and already set lastSpeakingTime from its inference/EOS path.
    internals.vad = {} as VAD;
    const vadSpeakingTime = 12345;
    internals.lastSpeakingTime = vadSpeakingTime;

    // isolate the EOS handler; the downstream EOU task resets lastSpeakingTime itself.
    vi.spyOn(recognition as never, 'runEOUDetection').mockImplementation(() => {});

    try {
      await internals.onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });

      // STT EOS must not clobber the VAD-derived value.
      expect(internals.lastSpeakingTime).toBe(vadSpeakingTime);
    } finally {
      await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
    }
  });

  it('stamps lastSpeakingTime on STT end-of-speech when there is no VAD', async () => {
    const { recognition, internals } = makeRecognition();
    internals.vad = undefined;
    internals.lastSpeakingTime = undefined;

    // isolate the EOS handler; the downstream EOU task resets lastSpeakingTime itself.
    vi.spyOn(recognition as never, 'runEOUDetection').mockImplementation(() => {});

    try {
      await internals.onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });

      expect(internals.lastSpeakingTime).toBeTypeOf('number');
    } finally {
      await internals.bounceEOUTask?.cancelAndWait().catch(() => {});
    }
  });
});
