// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { VAD, type VADEvent, type VADStream } from '../vad.js';
import {
  AudioRecognition,
  type RecognitionHooks,
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

// A VAD that never detects speech — models VAD missing a quiet utterance,
// which forces AudioRecognition to fall back to STT-derived timestamps.
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

function createHooks(): RecognitionHooks {
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

describe('AudioRecognition EOU scheduling with STT timestamps', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runTurn(opts: { sttEndTimeInS: number }) {
    vi.useFakeTimers();
    const hooks = createHooks();

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
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
      sttModel: 'stt-model',
      sttProvider: 'stt-provider',
      getLinkedParticipant: () => ({ sid: 'p1', identity: 'bob', kind: ParticipantKind.AGENT }),
    });

    // a freshly (re)started activity: input epoch base is "now", while the
    // (potentially reused) STT stream reports endTime relative to its own,
    // possibly much older, stream clock
    await ar.start({ inputStartedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);

    sttController.enqueue({
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          language: 'en',
          text: 'okay',
          startTime: 0,
          endTime: opts.sttEndTimeInS,
          confidence: 0.9,
        },
      ],
    });

    return { ar, hooks };
  }

  async function closeRecognition(ar: AudioRecognition) {
    vi.useRealTimers();
    await ar.close();
  }

  it('commits the user turn promptly when STT endTime maps to the past', async () => {
    const { ar, hooks } = await runTurn({ sttEndTimeInS: 0.5 });
    try {
      // endpointing delays are 0; the 0.5s stt offset is already in the past
      // relative to fake-now after 2s, so the turn must have committed
      await vi.advanceTimersByTimeAsync(2_000);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
    } finally {
      await closeRecognition(ar);
    }
  });

  it('does not stall the user turn commit when STT endTime maps to the future', async () => {
    // endTime of 120s on a stream whose epoch base is "now" puts
    // lastSpeakingTime ~2 minutes in the future (reused STT pipeline after a
    // handoff, or any stream-clock/input-epoch divergence). VAD missed the
    // utterance, so the STT timestamp is authoritative.
    const { ar, hooks } = await runTurn({ sttEndTimeInS: 120 });
    try {
      // the user turn must still commit within the endpointing window (0ms)
      // plus generous scheduling slack — NOT minutes later
      await vi.advanceTimersByTimeAsync(2_000);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
    } finally {
      await closeRecognition(ar);
    }
  });
});
