// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { BaseEndpointing } from './turn_config/endpointing.js';

class RecordingEndpointing extends BaseEndpointing {
  readonly agentSpeechStartedAt: number[] = [];
  readonly agentSpeechEndedAt: number[] = [];
  readonly speechStarts: Array<{ startedAt: number; overlapping: boolean }> = [];
  readonly speechEnds: Array<{ endedAt: number; shouldIgnore: boolean }> = [];

  override onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStartedAt.push(startedAt);
  }

  override onEndOfAgentSpeech(endedAt: number): void {
    this.agentSpeechEndedAt.push(endedAt);
  }

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    this.speechStarts.push({ startedAt, overlapping });
  }

  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    this.speechEnds.push({ endedAt, shouldIgnore });
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

// Ref: python livekit-agents/livekit/agents/voice/audio_recognition.py - 238-305, 915-1067 lines
describe('AudioRecognition endpointing integration', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delegates user speech lifecycle updates to the endpointing runtime', async () => {
    const endpointing = new RecordingEndpointing({ minDelay: 25, maxDelay: 75 });
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing,
    });

    await recognition.onStartOfAgentSpeech(900);
    (recognition as any).speaking = true;

    await recognition.onStartOfSpeech(950, 20);
    await recognition.onEndOfSpeech(1000, undefined, false);

    expect(endpointing.speechStarts).toEqual([{ startedAt: 950, overlapping: true }]);
    expect(endpointing.speechEnds).toEqual([{ endedAt: 1000, shouldIgnore: true }]);
  });

  it('updates the endpointing runtime when agent speech starts and ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1200);

    const endpointing = new RecordingEndpointing({ minDelay: 25, maxDelay: 75 });
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing,
    });

    await recognition.onStartOfAgentSpeech(1100);
    await recognition.onEndOfAgentSpeech(1150);

    expect(endpointing.agentSpeechStartedAt).toEqual([1100]);
    expect(endpointing.agentSpeechEndedAt).toEqual([1200]);
  });

  it('uses the endpointing runtime delay when scheduling end-of-turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const hooks = createHooks();
    const recognition = new AudioRecognition({
      recognitionHooks: hooks,
      endpointing: new RecordingEndpointing({ minDelay: 25, maxDelay: 75 }),
    });

    (recognition as any).audioTranscript = 'hello';
    (recognition as any).lastSpeakingTime = 1000;
    (recognition as any).lastFinalTranscriptTime = 1000;
    (recognition as any).speechStartTime = 900;

    (recognition as any).runEOUDetection(ChatContext.empty());

    await vi.advanceTimersByTimeAsync(24);
    expect(hooks.onEndOfTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.onEndOfTurn).toHaveBeenCalledTimes(1);
  });
});
