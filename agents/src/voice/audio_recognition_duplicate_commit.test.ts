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

// A VAD that never detects speech — forces AudioRecognition to fall back to
// STT-derived timestamps (matches audio_recognition_eou.test.ts).
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

describe('AudioRecognition duplicate EOU commit', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not commit a second, empty user turn when a bounce is created mid-commit', async () => {
    vi.useFakeTimers();

    // The commit hook is async (like AgentActivity.onEndOfTurn). Hold the FIRST
    // commit open so a second EOU bounce can be created in the window between the
    // first bounce reading the transcript and AudioRecognition resetting it.
    let releaseFirstCommit!: () => void;
    const firstCommitGate = new Promise<void>((resolve) => (releaseFirstCommit = resolve));
    const committedTranscripts: string[] = [];

    const hooks: RecognitionHooks = {
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
      onEndOfTurn: vi.fn(async (info) => {
        committedTranscripts.push(info.newTranscript);
        if (committedTranscripts.length === 1) {
          await firstCommitGate;
        }
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

    const finalTranscript = (text: string): SpeechEvent => ({
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ language: 'en', text, startTime: 0, endTime: 0.5, confidence: 0.9 }],
    });

    try {
      // First final creates bounce A; after the endpointing delay it enters
      // onEndOfTurn with "okay" and blocks on the gate.
      sttController.enqueue(finalTranscript('okay'));
      await vi.advanceTimersByTimeAsync(500);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);

      // A late VAD end-of-speech lands while the first commit is still in flight
      // (production: the VAD silence window makes end-of-speech arrive hundreds of
      // ms after the user stopped). It refreshes lastSpeakingTime and creates
      // bounce B, which passes the creation-time transcript guard (the transcript
      // hasn't been reset yet) and starts its own endpointing sleep.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arAny = ar as any;
      arAny.lastSpeakingTime = Date.now();
      arAny.runEOUDetection(ChatContext.empty(), 'vad');
      await vi.advanceTimersByTimeAsync(0);

      // The first commit completes: the transcript is committed and cleared.
      releaseFirstCommit();
      await vi.advanceTimersByTimeAsync(0);

      // Bounce B wakes up after its endpointing delay. The transcript it was
      // created for is already committed — it must NOT commit a second, empty turn.
      await vi.advanceTimersByTimeAsync(2_000);

      expect(committedTranscripts[0]).toBe('okay');
      const emptyCommits = committedTranscripts.filter((t) => t === '');
      expect(emptyCommits).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await ar.close();
    }
  });
});
