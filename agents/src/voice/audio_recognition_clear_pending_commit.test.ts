// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import type { SpeechEvent } from '../stt/stt.js';
import { VAD, type VADEvent, type VADStream } from '../vad.js';
import {
  AudioRecognition,
  type RecognitionHooks,
  STTPipeline,
  type _TurnDetector,
} from './audio_recognition.js';
import type { STTNode } from './io.js';

const turnDetector: _TurnDetector = {
  model: 'test-turn-detector',
  provider: 'test-provider',
  supportsLanguage: async () => true,
  unlikelyThreshold: async () => undefined,
  predictEndOfTurn: async () => 1.0,
};

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

describe('AudioRecognition clearUserTurn with a pending commitUserTurn', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the pending commit so it cannot fire inside the next manual turn', async () => {
    vi.useFakeTimers();

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
      onEndOfTurn: vi.fn(async () => true),
    };

    const sttNode: STTNode = async () => new ReadableStream<SpeechEvent | string>({ start() {} });

    const ar = new AudioRecognition({
      recognitionHooks: hooks,
      stt: sttNode,
      vad: new SilentVAD(),
      turnDetector,
      turnDetectionMode: 'manual',
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

    try {
      // Turn A is released with no final transcript yet, so the commit waits 500 ms for one.
      ar.commitUserTurn(false);
      await vi.advanceTimersByTimeAsync(100);

      // The user presses again inside that window (push-to-talk).
      ar.clearUserTurn();

      // The stale commit would run at 500 ms, inside turn B.
      await vi.advanceTimersByTimeAsync(2_000);

      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ar as any).userTurnCommitted).toBe(false);
    } finally {
      vi.useRealTimers();
      await ar.close();
    }
  });
});
