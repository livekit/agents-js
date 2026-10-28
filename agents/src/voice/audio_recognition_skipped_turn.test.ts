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
import { VAD, type VADEvent, type VADStream } from '../vad.js';
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
  stream(): any {
    return new SilentVADStream();
  }
}

const finalTranscript = (text: string): SpeechEvent => ({
  type: SpeechEventType.FINAL_TRANSCRIPT,
  alternatives: [{ language: 'en', text, startTime: 0, endTime: 0.5, confidence: 0.9 }],
});

/**
 * Starts recognition with an `onEndOfTurn` hook that behaves like AgentActivity's `minWords`
 * gate while the agent is speaking: turns below MIN_WORDS are skipped (returns false), longer
 * ones commit.
 */
async function startRecognition(
  options: { dropSkipped?: boolean; beforeDecision?: (call: number) => Promise<void> } = {},
) {
  const { dropSkipped = true, beforeDecision } = options;
  const seen: string[] = [];
  const committed: string[] = [];

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
    vad: new SilentVAD(),
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

  /** The user says `text`, then pauses long enough for end-of-turn detection to decide. */
  const say = async (text: string, pauseMs = 2_500) => {
    sttController.enqueue(finalTranscript(text));
    await vi.advanceTimersByTimeAsync(pauseMs);
  };

  return { ar, seen, committed, say };
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
