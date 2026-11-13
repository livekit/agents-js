// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import type { SpeechEvent } from '../stt/stt.js';
import { AudioRecognition, type RecognitionHooks, STTPipeline } from './audio_recognition.js';
import type { STTNode } from './io.js';

function createHooks(): RecognitionHooks {
  return {
    interruptionByAudioActivityEnabled: false,
    onOverlapSpeech: vi.fn(),
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

describe('AudioRecognition manual commitUserTurn', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends the turn right away when there is no STT', async () => {
    vi.useFakeTimers();
    const hooks = createHooks();
    // e.g. a realtime model with turnDetection: 'manual' and no STT
    const ar = new AudioRecognition({
      recognitionHooks: hooks,
      turnDetectionMode: 'manual',
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
    });
    await ar.start();

    try {
      ar.commitUserTurn(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(hooks.onEndOfTurn).toHaveBeenCalledOnce();
    } finally {
      // let a commit still waiting on a fake timer finish, or close() would hang on it
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      await ar.close();
    }
  });

  it('still waits for a final transcript when there is an STT', async () => {
    vi.useFakeTimers();
    const hooks = createHooks();
    const sttNode: STTNode = async () => new ReadableStream<SpeechEvent | string>({ start() {} });
    const ar = new AudioRecognition({
      recognitionHooks: hooks,
      stt: sttNode,
      turnDetectionMode: 'manual',
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
    });
    const pipeline = new STTPipeline(sttNode);
    pipeline.inputStartedAt = Date.now();
    await ar.start({ sttPipeline: pipeline });
    await vi.advanceTimersByTimeAsync(0);

    try {
      ar.commitUserTurn(false);
      await vi.advanceTimersByTimeAsync(499);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.onEndOfTurn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await ar.close();
    }
  });
});
