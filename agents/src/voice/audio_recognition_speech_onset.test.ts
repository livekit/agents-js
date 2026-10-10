// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechData, type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import {
  AudioRecognition,
  type EndOfTurnInfo,
  type RecognitionHooks,
} from './audio_recognition.js';

/** A VAD whose stream replays events pushed by the test. */
class ScriptedVAD extends VAD {
  label = 'scripted';
  private controller!: ReadableStreamDefaultController<VADEvent>;
  private events = new ReadableStream<VADEvent>({
    start: (c) => {
      this.controller = c;
    },
  });

  constructor() {
    super({ updateInterval: 1 });
  }

  push(event: VADEvent) {
    this.controller.enqueue(event);
  }

  finish() {
    this.controller.close();
  }

  stream(): VADStream {
    return {
      updateInputStream() {},
      detachInputStream() {},
      close() {},
      flush() {},
      [Symbol.asyncIterator]: () => this.events[Symbol.asyncIterator](),
    } as unknown as VADStream;
  }
}

interface RecognitionInternals {
  createVadTask: (vad: VAD, signal: AbortSignal) => Promise<void>;
  onSTTEvent: (event: SpeechEvent) => Promise<void>;
}

function setup() {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);

  const turns: EndOfTurnInfo[] = [];
  const hooks: RecognitionHooks = {
    onInterruption: vi.fn(),
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onTranscriptionTimeout: vi.fn(),
    onEotPrediction: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onUserTurnExceeded: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async (info: EndOfTurnInfo) => {
      turns.push(info);
      return true;
    }),
  };

  const vad = new ScriptedVAD();
  const recognition = new AudioRecognition({
    recognitionHooks: hooks,
    vad,
    turnDetectionMode: 'stt',
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
  });
  const internals = recognition as unknown as RecognitionInternals;
  const loop = internals.createVadTask(vad, new AbortController().signal);

  return {
    async vadEvent(type: VADEventType, at: number) {
      now = at;
      vad.push({
        type,
        samplesIndex: 0,
        timestamp: at,
        speechDuration: 100,
        silenceDuration: 0,
        frames: [],
        probability: 1,
        inferenceDuration: 5,
        speaking: type === VADEventType.START_OF_SPEECH,
        rawAccumulatedSilence: 0,
        rawAccumulatedSpeech: 0,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async commitTurn(at: number) {
      now = at;
      const alternatives: [SpeechData] = [
        { language: 'en', text: 'Example utterance.', startTime: 0, endTime: 0, confidence: 1 },
      ];
      await internals.onSTTEvent({ type: SpeechEventType.FINAL_TRANSCRIPT, alternatives });
      await internals.onSTTEvent({ type: SpeechEventType.END_OF_SPEECH, alternatives });
      await recognition.waitForEndOfTurnTask();
      return turns.at(-1)!;
    },
    async close() {
      vad.finish();
      await loop;
    },
  };
}

describe('AudioRecognition speech onset', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => vi.restoreAllMocks());

  it('does not take the next turn onset from a late VAD end of speech', async () => {
    const f = setup();
    try {
      await f.vadEvent(VADEventType.START_OF_SPEECH, 1000);
      await f.commitTurn(2000);
      await f.vadEvent(VADEventType.END_OF_SPEECH, 2010);
      await f.vadEvent(VADEventType.START_OF_SPEECH, 10000);

      const turn = await f.commitTurn(11000);
      expect(turn.startedSpeakingAt).toBe(10000 - 100 - 5);
    } finally {
      await f.close();
    }
  });

  it('reports no onset when only a VAD end of speech was observed', async () => {
    const f = setup();
    try {
      await f.vadEvent(VADEventType.END_OF_SPEECH, 10000);

      const turn = await f.commitTurn(11000);
      expect(turn.startedSpeakingAt).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('keeps the first onset across speech segments in one turn', async () => {
    const f = setup();
    try {
      await f.vadEvent(VADEventType.START_OF_SPEECH, 7000);
      await f.vadEvent(VADEventType.END_OF_SPEECH, 7600);
      await f.vadEvent(VADEventType.START_OF_SPEECH, 8500);

      const turn = await f.commitTurn(9000);
      expect(turn.startedSpeakingAt).toBe(7000 - 100 - 5);
    } finally {
      await f.close();
    }
  });
});
