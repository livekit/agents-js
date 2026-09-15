// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { Task } from '../utils.js';
import { type VAD, type VADEvent, VADEventType } from '../vad.js';
import {
  AudioRecognition,
  type AudioRecognitionOptions,
  type RecognitionHooks,
} from './audio_recognition.js';

type RecognitionInternals = {
  sttPipeline?: { close?: () => Promise<void> };
  vadSpeechStarted: boolean;
  isInterruptionEnabled: boolean;
  isAgentSpeaking: boolean;
  transcriptBuffer: SpeechEvent[];
  transcriptionTimeoutTimer?: ReturnType<typeof setTimeout>;
  turnSpeechDuration: number;
  turnTranscriptReceived: boolean;
  userTurnStart?: number;
  vadTask?: Task<void>;
  onSTTEvent: (event: SpeechEvent) => Promise<void>;
  createVadTask: (vad: VAD, signal: AbortSignal) => Promise<void>;
  armTranscriptionTimeout: (speechDuration: number, elapsedDelay: number) => void;
};

function createHooks(): RecognitionHooks {
  return {
    onInterruption: vi.fn(),
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onTranscriptionTimeout: vi.fn(),
    onEndOfTurn: vi.fn(async () => false),
    onEotPrediction: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onUserTurnExceeded: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
  };
}

function createRecognition(options: Partial<AudioRecognitionOptions> = {}) {
  const hooks = createHooks();
  const recognition = new AudioRecognition({
    recognitionHooks: hooks,
    turnDetectionMode: 'manual',
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
    ...options,
  });
  return { hooks, recognition, internals: recognition as unknown as RecognitionInternals };
}

function vadEvent(
  type: VADEventType.START_OF_SPEECH | VADEventType.END_OF_SPEECH,
  options: Partial<VADEvent> = {},
): VADEvent {
  return {
    type,
    samplesIndex: 0,
    timestamp: Date.now(),
    speechDuration: 1000,
    silenceDuration: 0,
    frames: [],
    probability: 1,
    inferenceDuration: 0,
    speaking: type === VADEventType.START_OF_SPEECH,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 0,
    ...options,
  };
}

async function driveVad(internals: RecognitionInternals, events: VADEvent[]): Promise<void> {
  const stream = {
    updateInputStream() {},
    detachInputStream() {},
    close() {},
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
  const vad = { stream: () => stream } as unknown as VAD;
  await internals.createVadTask(vad, new AbortController().signal);
}

function transcriptEvent(type: SpeechEventType, text: string): SpeechEvent {
  return { type, alternatives: [{ text, confidence: 1 }] };
}

describe('AudioRecognition transcription timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('held final transcript cancels the timeout', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.userTurnStart = Date.now();
    internals.armTranscriptionTimeout(1000, 0);
    internals.isInterruptionEnabled = true;
    internals.isAgentSpeaking = true;
    const event = transcriptEvent(SpeechEventType.FINAL_TRANSCRIPT, 'held transcript');

    await internals.onSTTEvent(event);
    await vi.advanceTimersByTimeAsync(2000);

    expect(internals.transcriptionTimeoutTimer).toBeUndefined();
    expect(internals.turnTranscriptReceived).toBe(true);
    expect(internals.transcriptBuffer).toEqual([event]);
    expect(hooks.onFinalTranscript).not.toHaveBeenCalled();
    expect(hooks.onTranscriptionTimeout).not.toHaveBeenCalled();
  });

  it('preflight transcript does not cancel the timeout', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.userTurnStart = Date.now();
    internals.armTranscriptionTimeout(1000, 0);

    await internals.onSTTEvent(
      transcriptEvent(SpeechEventType.PREFLIGHT_TRANSCRIPT, 'preflight transcript'),
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(internals.turnTranscriptReceived).toBe(false);
    expect(hooks.onTranscriptionTimeout).toHaveBeenCalledOnce();
  });

  it('accounts for VAD endpointing delay', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.sttPipeline = {};
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 500, inferenceDuration: 250 }),
    ]);

    await vi.advanceTimersByTimeAsync(1249);
    expect(hooks.onTranscriptionTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.onTranscriptionTimeout).toHaveBeenCalledOnce();
  });

  it('does not arm for late VAD end-of-speech after a committed turn', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.sttPipeline = {};
    internals.vadSpeechStarted = false;

    await driveVad(internals, [vadEvent(VADEventType.END_OF_SPEECH)]);
    await vi.advanceTimersByTimeAsync(2000);

    expect(internals.transcriptionTimeoutTimer).toBeUndefined();
    expect(hooks.onTranscriptionTimeout).not.toHaveBeenCalled();
  });

  it('clearUserTurn resets the timeout state', () => {
    const { recognition, internals } = createRecognition({ transcriptionTimeout: 1000 });
    internals.userTurnStart = Date.now();
    internals.turnSpeechDuration = 2000;
    internals.turnTranscriptReceived = true;
    internals.transcriptionTimeoutTimer = setTimeout(() => {}, 60_000);

    recognition.clearUserTurn();

    expect(internals.transcriptionTimeoutTimer).toBeUndefined();
    expect(internals.turnSpeechDuration).toBe(0);
    expect(internals.turnTranscriptReceived).toBe(false);
    expect(internals.userTurnStart).toBeUndefined();
    internals.userTurnStart = Date.now();
    internals.armTranscriptionTimeout(1000, 0);
    expect(internals.transcriptionTimeoutTimer).toBeDefined();
  });

  it('fires when VAD speech is not transcribed', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.sttPipeline = {};
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH, { speechDuration: 2000 }),
    ]);

    await vi.advanceTimersByTimeAsync(2000);

    expect(hooks.onTranscriptionTimeout).toHaveBeenCalledWith(2000, 9000);
  });

  it('does not fire when a final transcript arrives', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.sttPipeline = {};
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH),
    ]);
    await internals.onSTTEvent(transcriptEvent(SpeechEventType.FINAL_TRANSCRIPT, 'hello'));

    await vi.advanceTimersByTimeAsync(2000);

    expect(hooks.onTranscriptionTimeout).not.toHaveBeenCalled();
  });

  it('fires when only an interim transcript arrives', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.sttPipeline = {};
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH),
    ]);
    await internals.onSTTEvent(transcriptEvent(SpeechEventType.INTERIM_TRANSCRIPT, 'hello'));

    await vi.advanceTimersByTimeAsync(2000);

    expect(hooks.onTranscriptionTimeout).toHaveBeenCalledOnce();
  });

  it('is disabled by default', async () => {
    const { hooks, internals } = createRecognition();
    internals.sttPipeline = {};
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH),
    ]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(hooks.onTranscriptionTimeout).not.toHaveBeenCalled();
  });

  it('fires while the agent is speaking', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.sttPipeline = {};
    internals.isAgentSpeaking = true;
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH),
    ]);

    await vi.advanceTimersByTimeAsync(2000);

    expect(hooks.onTranscriptionTimeout).toHaveBeenCalledOnce();
  });

  it('does not fire without STT', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH),
    ]);

    await vi.advanceTimersByTimeAsync(2000);

    expect(hooks.onTranscriptionTimeout).not.toHaveBeenCalled();
  });

  it('accumulates speech across bursts', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.sttPipeline = {};
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH),
    ]);

    await vi.advanceTimersByTimeAsync(2000);

    expect(hooks.onTranscriptionTimeout).toHaveBeenCalledWith(2000, 9000);
  });

  it('refires on the next attempt in the same uncommitted turn', async () => {
    const { hooks, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.sttPipeline = {};
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH),
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    await driveVad(internals, [
      vadEvent(VADEventType.START_OF_SPEECH),
      vadEvent(VADEventType.END_OF_SPEECH),
    ]);
    await vi.advanceTimersByTimeAsync(2000);

    expect(hooks.onTranscriptionTimeout).toHaveBeenNthCalledWith(1, 1000, 9000);
    expect(hooks.onTranscriptionTimeout).toHaveBeenNthCalledWith(2, 2000, 9000);
  });

  it('does not re-arm for a buffered end-of-speech delivered during close', async () => {
    // `close()` only aborts the VAD consumer partway through its teardown, so an
    // END_OF_SPEECH buffered before the abort is still processed while
    // `sttPipeline` is set — python cancels the timeout at the very end of
    // `_aclose()` for exactly this reason.
    let releaseEndOfSpeech!: () => void;
    const endOfSpeechGate = new Promise<void>((resolve) => {
      releaseEndOfSpeech = resolve;
    });
    const stream = {
      updateInputStream() {},
      detachInputStream() {},
      close() {},
      async *[Symbol.asyncIterator]() {
        yield vadEvent(VADEventType.START_OF_SPEECH);
        await endOfSpeechGate;
        // A silence duration at or beyond the timeout collapses the remaining
        // delay to 0, so the callback lands on the very next macrotask.
        yield vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 2000 });
      },
    };
    const vad = { stream: () => stream } as unknown as VAD;

    const { hooks, recognition, internals } = createRecognition({ transcriptionTimeout: 2000 });
    internals.sttPipeline = {
      // `close()` awaits this before it aborts the VAD task and before it clears
      // `sttPipeline`, which is precisely the window the buffered event lands in.
      close: async () => {
        releaseEndOfSpeech();
        await vi.advanceTimersByTimeAsync(0);
      },
    };
    internals.vadTask = Task.from(({ signal }) => internals.createVadTask(vad, signal));
    await vi.advanceTimersByTimeAsync(0);
    expect(internals.userTurnStart).toBeDefined();

    await recognition.close();

    expect(hooks.onTranscriptionTimeout).not.toHaveBeenCalled();
    expect(internals.transcriptionTimeoutTimer).toBeUndefined();
  });
});
