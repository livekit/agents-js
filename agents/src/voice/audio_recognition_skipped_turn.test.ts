// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { splitWords } from '../tokenize/basic/word.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import {
  AudioRecognition,
  type EndOfTurnInfo,
  type RecognitionHooks,
  STTPipeline,
  type _TurnDetector,
} from './audio_recognition.js';
import type { STTNode } from './io.js';

const MIN_WORDS = 2;

const fastTurnDetector: _TurnDetector = {
  model: 'test-turn-detector',
  provider: 'test-provider',
  supportsLanguage: async () => true,
  unlikelyThreshold: async () => undefined,
  predictEndOfTurn: async () => 1.0,
};

// A VAD that never detects speech, so finals drive end-of-turn detection on their own.
class SilentVADStream extends (Object as unknown as { new (): VADStream }) {
  updateInputStream() {}
  detachInputStream() {}
  close() {}
  [Symbol.asyncIterator]() {
    return this;
  }
  async next(): Promise<IteratorResult<VADEvent>> {
    return { done: true, value: undefined };
  }
}

class SilentVAD extends VAD {
  label = 'silent-vad';
  constructor() {
    super({ updateInterval: 1 });
  }
  stream(): VADStream {
    return new SilentVADStream();
  }
}

// A VAD the test drives: each pushed event is delivered to recognition as it happens.
class ScriptedVADStream extends (Object as unknown as { new (): VADStream }) {
  private queue: VADEvent[] = [];
  private waiter?: (result: IteratorResult<VADEvent>) => void;
  private closed = false;
  push(ev: VADEvent) {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) waiter({ done: false, value: ev });
    else this.queue.push(ev);
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
    return new Promise((resolve) => (this.waiter = resolve));
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

const vadEvent = (
  type: VADEventType.START_OF_SPEECH | VADEventType.END_OF_SPEECH,
  durations: { speechDuration?: number; silenceDuration?: number } = {},
): VADEvent => ({
  type,
  samplesIndex: 0,
  timestamp: Date.now(),
  speechDuration: durations.speechDuration ?? 0,
  silenceDuration: durations.silenceDuration ?? 0,
  frames: [],
  probability: 0,
  inferenceDuration: 0,
  speaking: type === VADEventType.START_OF_SPEECH,
  rawAccumulatedSilence: 0,
  rawAccumulatedSpeech: 0,
});

/** A final for speech that ends now, timed against the STT input start. */
const finalTranscript = (text: string, inputStartedAt: number, confidence: number): SpeechEvent => {
  const endTimeInS = (Date.now() - inputStartedAt) / 1000;
  return {
    type: SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [
      {
        language: 'en',
        text,
        startTime: Math.max(endTimeInS - 0.4, 0),
        endTime: endTimeInS,
        confidence,
      },
    ],
  };
};

/**
 * Starts recognition with an `onEndOfTurn` hook that behaves like AgentActivity's `minWords`
 * gate while the agent is speaking: turns below MIN_WORDS are skipped (returns false), longer
 * ones commit.
 */
async function startRecognition(
  options: {
    dropSkipped?: boolean;
    beforeDecision?: (call: number) => Promise<void>;
    vad?: VAD;
  } = {},
) {
  const { dropSkipped = true, beforeDecision, vad = new SilentVAD() } = options;
  const seen: string[] = [];
  const committed: string[] = [];
  const infos: EndOfTurnInfo[] = [];

  const hooks: RecognitionHooks = {
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
    onUserTurnExceeded: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async (info: EndOfTurnInfo) => {
      seen.push(info.newTranscript);
      infos.push(info);
      await beforeDecision?.(seen.length);
      if (splitWords(info.newTranscript, true).length < MIN_WORDS) {
        if (dropSkipped) info.dropTranscript = true;
        return false;
      }
      committed.push(info.newTranscript);
      return true;
    }),
  };

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
    minEndpointingDelay: 300,
    maxEndpointingDelay: 300,
    sttModel: 'stt-model',
    sttProvider: 'stt-provider',
    getLinkedParticipant: () => ({ sid: 'p1', identity: 'bob', kind: ParticipantKind.AGENT }),
  });

  const pipeline = new STTPipeline(sttNode);
  pipeline.inputStartedAt = Date.now();
  await ar.start({ sttPipeline: pipeline });
  await vi.advanceTimersByTimeAsync(0);

  /** The user says `text`, then pauses for `pauseMs` (long enough for a decision by default). */
  const say = async (text: string, pauseMs = 2_500, confidence = 0.9) => {
    sttController.enqueue(finalTranscript(text, pipeline.inputStartedAt!, confidence));
    await vi.advanceTimersByTimeAsync(pauseMs);
  };

  return { ar, seen, committed, infos, say };
}

describe('AudioRecognition - turns skipped below minWords', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not prefix the next committed turn with a skipped backchannel', async () => {
    const { ar, seen, committed, say } = await startRecognition();
    try {
      await say('Okay.');
      await say('Stop right there.');

      expect(seen).toEqual(['Okay.', 'Stop right there.']);
      expect(committed).toEqual(['Stop right there.']);
    } finally {
      await ar.close();
    }
  });

  it('does not let skipped backchannels add up to minWords', async () => {
    const { ar, seen, committed, say } = await startRecognition();
    try {
      await say('Right.');
      await say('Right.');
      await say('Right.');

      expect(seen).toEqual(['Right.', 'Right.', 'Right.']);
      expect(committed).toEqual([]);
      expect(ar.currentTranscript).toBe('');
    } finally {
      await ar.close();
    }
  });

  it('still commits words the user adds while the skip decision is pending', async () => {
    let releaseFirstDecision!: () => void;
    const firstDecision = new Promise<void>((resolve) => (releaseFirstDecision = resolve));
    const { ar, seen, committed, say } = await startRecognition({
      beforeDecision: async (call) => {
        if (call === 1) await firstDecision;
      },
    });
    try {
      // "Wait." is still being decided when the user goes on: the next trigger sees both parts
      await say('Wait.', 500);
      await say('hold on');
      expect(seen).toEqual(['Wait.', 'Wait. hold on']);
      expect(committed).toEqual(['Wait. hold on']);

      // the late skip finds its text already committed and must not touch the next turn
      releaseFirstDecision();
      await vi.advanceTimersByTimeAsync(0);
      await say('Thanks a lot.');
      expect(committed).toEqual(['Wait. hold on', 'Thanks a lot.']);
    } finally {
      await ar.close();
    }
  });

  it('drops the confidence of skipped words but keeps a newer final', async () => {
    let releaseFirstDecision!: () => void;
    const firstDecision = new Promise<void>((resolve) => (releaseFirstDecision = resolve));
    const { ar, committed, infos, say } = await startRecognition({
      beforeDecision: async (call) => {
        if (call === 1) await firstDecision;
      },
    });
    try {
      await say('Okay.', 400, 0.2);
      // the user speaks again while "Okay." is being decided. Production VAD refreshes
      // lastSpeakingTime for the new speech, so its decision waits for the endpointing delay;
      // this VAD is silent, so set it as the duplicate-commit test does
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ar as any).lastSpeakingTime = Date.now();
      await say('Stop right there.', 0, 0.9);
      releaseFirstDecision();
      await vi.advanceTimersByTimeAsync(2_500);

      expect(committed).toEqual(['Stop right there.']);
      expect(infos.at(-1)!.transcriptConfidence).toBeCloseTo(0.9);
    } finally {
      await ar.close();
    }
  });

  it('ends the skipped turn so the next one does not inherit its start', async () => {
    const { ar, infos, say } = await startRecognition();
    try {
      await say('Okay.');
      // the skipped turn's span and start anchor are gone
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arAny = ar as any;
      expect(arAny.userTurnStart).toBeUndefined();
      expect(arAny.userTurnSpan).toBeUndefined();

      await vi.advanceTimersByTimeAsync(10_000);
      await say('Stop right there.');

      // this VAD is silent, so a fresh turn has no speech-start anchor: the second turn must
      // report what the first did, not the skipped word's start 12.5s earlier
      expect(infos[1]!.newTranscript).toBe('Stop right there.');
      expect(infos[1]!.startedSpeakingAt).toBe(infos[0]!.startedSpeakingAt);
    } finally {
      await ar.close();
    }
  });

  it('keeps the turn of speech that resumed during the skip decision, starting at the resume', async () => {
    const vad = new ScriptedVAD();
    let releaseFirstDecision!: () => void;
    const firstDecision = new Promise<void>((resolve) => (releaseFirstDecision = resolve));
    const { ar, committed, infos, say } = await startRecognition({
      vad,
      beforeDecision: async (call) => {
        if (call === 1) await firstDecision;
      },
    });
    try {
      await say('Okay.', 400);
      await vi.advanceTimersByTimeAsync(5_000);

      // the user starts "Stop right there" while "Okay." is still being decided; no final yet
      vad.vadStream.push(vadEvent(VADEventType.START_OF_SPEECH, { speechDuration: 100 }));
      await vi.advanceTimersByTimeAsync(0);
      const resumedAt = Date.now() - 100;
      releaseFirstDecision();
      await vi.advanceTimersByTimeAsync(800);

      vad.vadStream.push(vadEvent(VADEventType.END_OF_SPEECH));
      await say('Stop right there.');

      expect(committed).toEqual(['Stop right there.']);
      expect(infos.at(-1)!.startedSpeakingAt).toBe(resumedAt);
    } finally {
      await ar.close();
    }
  });

  it('keeps a skipped transcript when the activity does not ask to drop it', async () => {
    const { ar, seen, say } = await startRecognition({ dropSkipped: false });
    try {
      await say('Okay.');
      await say('Stop right there.');

      // other deferred decisions keep the old behaviour: the text waits for the next trigger
      expect(seen).toEqual(['Okay.', 'Okay. Stop right there.']);
    } finally {
      await ar.close();
    }
  });
});
