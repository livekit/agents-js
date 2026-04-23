// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import {
  AudioRecognition,
  type RecognitionHooks,
  type _TurnDetector,
} from './audio_recognition.js';
import { BaseEndpointing } from './endpointing.js';

class RecordingEndpointing extends BaseEndpointing {
  readonly speechStarts: Array<{ startedAt: number; overlapping: boolean }> = [];
  readonly speechEnds: Array<{ endedAt: number; shouldIgnore: boolean }> = [];
  readonly agentSpeechStarts: number[] = [];
  readonly agentSpeechEnds: number[] = [];

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    super.onStartOfSpeech(startedAt, overlapping);
    this.speechStarts.push({ startedAt, overlapping });
  }

  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    super.onEndOfSpeech(endedAt, shouldIgnore);
    this.speechEnds.push({ endedAt, shouldIgnore });
  }

  override onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStarts.push(startedAt);
  }

  override onEndOfAgentSpeech(endedAt: number): void {
    this.agentSpeechEnds.push(endedAt);
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
    onEndOfTurn: vi.fn(async () => true),
    onPreemptiveGeneration: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
  };
}

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

describe('AudioRecognition endpointing integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Ref: python livekit-agents/livekit/agents/voice/audio_recognition.py - 915-990 lines
  it('uses endpointing.maxDelay when the turn detector predicts an unlikely turn end', async () => {
    const hooks = createHooks();
    const endpointing = new RecordingEndpointing(100, 600);
    const turnDetector: _TurnDetector = {
      model: 'fake-turn-detector',
      provider: 'fake-provider',
      supportsLanguage: async () => true,
      unlikelyThreshold: async () => 0.2,
      predictEndOfTurn: async () => 0.1,
    };
    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      endpointing,
      turnDetector,
      turnDetectionMode: 'vad',
    });

    try {
      (recognition as any).audioTranscript = 'hello';
      (recognition as any).lastSpeakingTime = Date.now();

      (recognition as any).runEOUDetection(ChatContext.empty());

      await vi.advanceTimersByTimeAsync(599);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
    } finally {
      await recognition.close();
    }
  });

  // Ref: python livekit-agents/livekit/agents/voice/audio_recognition.py - 192-220 lines
  it('replaces the endpointing instance on updateOptions', async () => {
    const hooks = createHooks();
    const initialEndpointing = new RecordingEndpointing(100, 100);
    const replacementEndpointing = new RecordingEndpointing(400, 400);
    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      endpointing: initialEndpointing,
      turnDetectionMode: 'vad',
    });

    try {
      recognition.updateOptions({
        endpointing: replacementEndpointing,
        turnDetection: 'vad',
      });

      recognition.onStartOfSpeech(100_123);

      expect(initialEndpointing.speechStarts).toEqual([]);
      expect(replacementEndpointing.speechStarts).toEqual([
        { startedAt: 100_123, overlapping: false },
      ]);

      (recognition as any).audioTranscript = 'hello';
      (recognition as any).lastSpeakingTime = Date.now();
      (recognition as any).runEOUDetection(ChatContext.empty());

      await vi.advanceTimersByTimeAsync(399);
      expect(hooks.onEndOfTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
    } finally {
      await recognition.close();
    }
  });

  // Ref: python livekit-agents/livekit/agents/voice/audio_recognition.py - 291-303 lines
  it('marks overlapping non-interruptions as shouldIgnore on speech end', async () => {
    const hooks = createHooks();
    const endpointing = new RecordingEndpointing(100, 600);
    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      endpointing,
      turnDetectionMode: 'vad',
    });

    try {
      (recognition as any).speaking = true;
      (recognition as any).isAgentSpeaking = true;
      (recognition as any).isInterruptionEnabled = true;
      (recognition as any).interruptionDetected = false;

      recognition.onEndOfSpeech(100_250);

      expect(endpointing.speechEnds).toEqual([{ endedAt: 100_250, shouldIgnore: true }]);
    } finally {
      await recognition.close();
    }
  });
});
