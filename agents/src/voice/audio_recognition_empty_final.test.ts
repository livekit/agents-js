// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import {
  AudioRecognition,
  type AudioRecognitionOptions,
  type RecognitionHooks,
  STTPipeline,
  type _TurnDetector,
} from './audio_recognition.js';
import type { STTNode } from './io.js';

const fastTurnDetector: _TurnDetector = {
  model: 'test-turn-detector',
  provider: 'test-provider',
  supportsLanguage: async () => true,
  unlikelyThreshold: async () => undefined,
  predictEndOfTurn: async () => 1.0,
};

// A VAD whose events the test pushes one at a time.
class ScriptedVADStream extends (Object as unknown as { new (): VADStream }) {
  private queue: VADEvent[] = [];
  private waiter?: (result: IteratorResult<VADEvent>) => void;
  private closed = false;

  push(ev: VADEvent) {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ done: false, value: ev });
    } else {
      this.queue.push(ev);
    }
  }

  updateInputStream() {}
  detachInputStream() {}
  close() {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  async next(): Promise<IteratorResult<VADEvent>> {
    const ev = this.queue.shift();
    if (ev) return { done: false, value: ev };
    if (this.closed) return { done: true, value: undefined };
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

class ScriptedVAD extends VAD {
  label = 'scripted-vad';
  readonly vadStream = new ScriptedVADStream();
  constructor() {
    super({ updateInterval: 1 });
  }
  stream(): VADStream {
    return this.vadStream;
  }
}

function vadEvent(type: VADEventType, options: Partial<VADEvent> = {}): VADEvent {
  return {
    type,
    samplesIndex: 0,
    timestamp: Date.now(),
    speechDuration: 0,
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

function transcript(type: SpeechEventType, text: string): SpeechEvent {
  return {
    type,
    alternatives: [{ language: 'en', text, startTime: 0, endTime: 0, confidence: 1 }],
  };
}

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
    onEndOfTurn: vi.fn(async () => true),
    onEotPrediction: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onUserTurnExceeded: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
  };
}

describe('AudioRecognition with an empty final transcript', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startRecognition(options: Partial<AudioRecognitionOptions> = {}) {
    vi.useFakeTimers();
    const hooks = createHooks();
    const vad = new ScriptedVAD();

    let sttController!: ReadableStreamDefaultController<SpeechEvent | string>;
    const sttNode: STTNode = async () =>
      new ReadableStream<SpeechEvent | string>({
        start(controller) {
          sttController = controller;
        },
      });

    const ar = new AudioRecognition({
      recognitionHooks: hooks,
      stt: sttNode,
      vad,
      turnDetector: fastTurnDetector,
      turnDetectionMode: 'vad',
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
      sttModel: 'stt-model',
      sttProvider: 'stt-provider',
      getLinkedParticipant: () => ({ sid: 'p1', identity: 'bob', kind: ParticipantKind.AGENT }),
      ...options,
    });

    const pipeline = new STTPipeline(sttNode);
    pipeline.inputStartedAt = Date.now();
    await ar.start({ sttPipeline: pipeline });
    await vi.advanceTimersByTimeAsync(0);

    const stt = async (ev: SpeechEvent) => {
      sttController.enqueue(ev);
      await vi.advanceTimersByTimeAsync(0);
    };
    const vadPush = async (ev: VADEvent) => {
      vad.vadStream.push(ev);
      await vi.advanceTimersByTimeAsync(0);
    };
    return { ar, hooks, stt, vadPush, vad };
  }

  async function closeRecognition(ar: AudioRecognition, vad: ScriptedVAD) {
    vi.useRealTimers();
    vad.vadStream.close();
    await ar.close();
  }

  it('commits a non-empty final after VAD end of speech', async () => {
    const { ar, hooks, stt, vadPush, vad } = await startRecognition();
    try {
      await vadPush(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
      await stt(transcript(SpeechEventType.INTERIM_TRANSCRIPT, 'Pick up.'));
      await vadPush(vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 500 }));
      await vi.advanceTimersByTimeAsync(1_000);
      await stt(transcript(SpeechEventType.FINAL_TRANSCRIPT, 'Pick up.'));

      await vi.advanceTimersByTimeAsync(2_000);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(hooks.onEndOfTurn).mock.calls[0]![0].newTranscript).toBe('Pick up.');
    } finally {
      await closeRecognition(ar, vad);
    }
  });

  it('commits the buffered interim when the provider ends the segment with an empty final', async () => {
    // A short reply ("Pick up.") reaches the agent as an interim; VAD sees the caller stop;
    // the provider then closes the segment with an empty final instead of the words.
    const { ar, hooks, stt, vadPush, vad } = await startRecognition();
    try {
      await vadPush(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
      await stt(transcript(SpeechEventType.INTERIM_TRANSCRIPT, 'Pick up.'));
      await vadPush(vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 500 }));
      await vi.advanceTimersByTimeAsync(1_000);
      await stt(transcript(SpeechEventType.FINAL_TRANSCRIPT, ''));

      await vi.advanceTimersByTimeAsync(2_000);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(hooks.onEndOfTurn).mock.calls[0]![0].newTranscript).toBe('Pick up.');
    } finally {
      await closeRecognition(ar, vad);
    }
  });

  it('promotes the cumulative interim, not a chunked preflight, when the final is empty', async () => {
    // AssemblyAI's plugin sends the turn's words as the interim and only the words since the
    // last preflight as the preflight.
    const { ar, hooks, stt, vadPush, vad } = await startRecognition();
    try {
      await vadPush(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
      await stt(transcript(SpeechEventType.INTERIM_TRANSCRIPT, 'Pick up'));
      await stt(transcript(SpeechEventType.PREFLIGHT_TRANSCRIPT, 'up'));
      await vadPush(vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 500 }));
      await vi.advanceTimersByTimeAsync(1_000);
      await stt(transcript(SpeechEventType.FINAL_TRANSCRIPT, ''));

      await vi.advanceTimersByTimeAsync(2_000);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(hooks.onEndOfTurn).mock.calls[0]![0].newTranscript).toBe('Pick up');
    } finally {
      await closeRecognition(ar, vad);
    }
  });

  it.each([
    { name: 'without a preceding interim', interim: undefined, preflight: 'Pick up' },
    { name: 'that adds words to the interim', interim: 'Pick', preflight: 'Pick up' },
  ])(
    'promotes a full-segment preflight $name when the final is empty',
    async ({ interim, preflight }) => {
      const { ar, hooks, stt, vadPush, vad } = await startRecognition();
      try {
        await vadPush(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
        if (interim !== undefined) {
          await stt(transcript(SpeechEventType.INTERIM_TRANSCRIPT, interim));
        }
        await stt(transcript(SpeechEventType.PREFLIGHT_TRANSCRIPT, preflight));
        await vadPush(vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 500 }));
        await vi.advanceTimersByTimeAsync(1_000);
        await stt(transcript(SpeechEventType.FINAL_TRANSCRIPT, ''));

        await vi.advanceTimersByTimeAsync(2_000);
        expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
        expect(vi.mocked(hooks.onEndOfTurn).mock.calls[0]![0].newTranscript).toBe(preflight);
      } finally {
        await closeRecognition(ar, vad);
      }
    },
  );

  it('promotes an interim that grew past the last preflight when the final is empty', async () => {
    const { ar, hooks, stt, vadPush, vad } = await startRecognition();
    try {
      await vadPush(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
      await stt(transcript(SpeechEventType.PREFLIGHT_TRANSCRIPT, 'Pick up'));
      await stt(transcript(SpeechEventType.INTERIM_TRANSCRIPT, 'Pick up please'));
      await vadPush(vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 500 }));
      await vi.advanceTimersByTimeAsync(1_000);
      await stt(transcript(SpeechEventType.FINAL_TRANSCRIPT, ''));

      await vi.advanceTimersByTimeAsync(2_000);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(hooks.onEndOfTurn).mock.calls[0]![0].newTranscript).toBe('Pick up please');
    } finally {
      await closeRecognition(ar, vad);
    }
  });

  it.each([
    { name: 'a shorter interim', interim: 'Pick', expected: 'Pick' as string | undefined },
    { name: 'an empty interim', interim: '', expected: undefined },
  ])(
    'keeps the retraction when $name follows the preflight and the final is empty',
    async ({ interim, expected }) => {
      const { ar, hooks, stt, vadPush, vad } = await startRecognition();
      try {
        await vadPush(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
        await stt(transcript(SpeechEventType.PREFLIGHT_TRANSCRIPT, 'Pick up'));
        await stt(transcript(SpeechEventType.INTERIM_TRANSCRIPT, interim));
        await vadPush(vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 500 }));
        await vi.advanceTimersByTimeAsync(1_000);
        await stt(transcript(SpeechEventType.FINAL_TRANSCRIPT, ''));

        await vi.advanceTimersByTimeAsync(2_000);
        if (expected === undefined) {
          expect(hooks.onEndOfTurn).not.toHaveBeenCalled();
        } else {
          expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
          expect(vi.mocked(hooks.onEndOfTurn).mock.calls[0]![0].newTranscript).toBe(expected);
        }
      } finally {
        await closeRecognition(ar, vad);
      }
    },
  );

  it('counts the promoted interim as the turn transcript for the transcription timeout', async () => {
    // An unlikely end-of-turn holds the commit for maxEndpointingDelay, past the timeout.
    const { ar, hooks, stt, vadPush, vad } = await startRecognition({
      transcriptionTimeout: 3_000,
      maxEndpointingDelay: 10_000,
      turnDetector: {
        ...fastTurnDetector,
        unlikelyThreshold: async () => 0.5,
        predictEndOfTurn: async () => 0.1,
      },
    });
    try {
      await vadPush(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
      await stt(transcript(SpeechEventType.INTERIM_TRANSCRIPT, 'Pick up.'));
      await vadPush(vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 500 }));
      await vi.advanceTimersByTimeAsync(1_000);
      await stt(transcript(SpeechEventType.FINAL_TRANSCRIPT, ''));

      await vi.advanceTimersByTimeAsync(4_000);
      expect(hooks.onTranscriptionTimeout).not.toHaveBeenCalled();
    } finally {
      await closeRecognition(ar, vad);
    }
  });

  it('does not open a turn for an empty final with no buffered interim', async () => {
    const { ar, hooks, stt, vadPush, vad } = await startRecognition();
    try {
      await vadPush(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
      await vadPush(vadEvent(VADEventType.END_OF_SPEECH, { silenceDuration: 500 }));
      await stt(transcript(SpeechEventType.FINAL_TRANSCRIPT, ''));

      await vi.advanceTimersByTimeAsync(2_000);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();
    } finally {
      await closeRecognition(ar, vad);
    }
  });

  it('drops an interim that VAD never heard as speech when the final comes back empty', async () => {
    // With no VAD speech in the turn, an interim the provider retracts is treated as noise.
    const { ar, hooks, stt, vad } = await startRecognition();
    try {
      await stt(transcript(SpeechEventType.INTERIM_TRANSCRIPT, 'uh'));
      await stt(transcript(SpeechEventType.FINAL_TRANSCRIPT, ''));

      await vi.advanceTimersByTimeAsync(2_000);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();
    } finally {
      await closeRecognition(ar, vad);
    }
  });
});
