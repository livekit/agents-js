// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { AgentActivity } from './agent_activity.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { DynamicEndpointing, createEndpointing } from './endpointing.js';

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

afterEach(() => {
  vi.useRealTimers();
});

describe('endpointing runtime integration', () => {
  it('replaces learned dynamic endpointing state when updateOptions swaps endpointing', () => {
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing: new DynamicEndpointing(300, 1000, 0.5),
    });

    const learned = (recognition as any).endpointing as DynamicEndpointing;
    learned.onEndOfSpeech(100000);
    learned.onStartOfSpeech(100400);
    learned.onEndOfSpeech(100600);
    expect(learned.minDelay).toBeCloseTo(350, 5);

    recognition.updateOptions({
      endpointing: createEndpointing({ mode: 'dynamic', minDelay: 300, maxDelay: 1000 }),
    });

    const replaced = (recognition as any).endpointing as DynamicEndpointing;
    expect(replaced).not.toBe(learned);
    expect(replaced.minDelay).toBe(300);
    expect(replaced.maxDelay).toBe(1000);
  });

  it('routes VAD speech callbacks through audioRecognition public endpointing hooks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const audioRecognition = {
      onStartOfSpeech: vi.fn(),
      onEndOfSpeech: vi.fn(),
    };

    const fakeActivity = {
      agentSession: {
        _updateUserState: vi.fn(),
        _userSpeakingSpan: undefined,
      },
      audioRecognition,
      interruptionDetected: true,
      isInterruptionDetectionEnabled: true,
    };

    const onStartOfSpeech = (AgentActivity.prototype as any).onStartOfSpeech as (
      this: unknown,
      ev: { speechDuration: number; inferenceDuration: number },
    ) => void;
    const onEndOfSpeech = (AgentActivity.prototype as any).onEndOfSpeech as (
      this: unknown,
      ev: { silenceDuration: number; inferenceDuration: number },
    ) => void;

    onStartOfSpeech.call(fakeActivity, { speechDuration: 100, inferenceDuration: 20 });
    expect(audioRecognition.onStartOfSpeech).toHaveBeenCalledWith(880, 100, undefined);

    vi.setSystemTime(1600);
    onEndOfSpeech.call(fakeActivity, { silenceDuration: 50, inferenceDuration: 20 });
    expect(audioRecognition.onEndOfSpeech).toHaveBeenCalledWith(1530, undefined, false);
  });

  it('routes realtime no-vad speech callbacks through audioRecognition public endpointing hooks', () => {
    vi.useFakeTimers();

    const audioRecognition = {
      onStartOfSpeech: vi.fn(),
      onEndOfSpeech: vi.fn(),
    };

    const fakeActivity = {
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      vad: undefined,
      agentSession: {
        _updateUserState: vi.fn(),
        _userSpeakingSpan: undefined,
        emit: vi.fn(),
      },
      audioRecognition,
      interruptionDetected: false,
      isInterruptionDetectionEnabled: true,
      interrupt: vi.fn(),
    };

    const onInputSpeechStarted = (AgentActivity.prototype as any).onInputSpeechStarted as (
      this: unknown,
      ev: Record<string, never>,
    ) => void;
    const onInputSpeechStopped = (AgentActivity.prototype as any).onInputSpeechStopped as (
      this: unknown,
      ev: { userTranscriptionEnabled: boolean },
    ) => void;

    vi.setSystemTime(1000);
    onInputSpeechStarted.call(fakeActivity, {});
    expect(audioRecognition.onStartOfSpeech).toHaveBeenCalledWith(1000, 0, undefined);

    fakeActivity.interruptionDetected = true;
    vi.setSystemTime(1400);
    onInputSpeechStopped.call(fakeActivity, { userTranscriptionEnabled: false });
    expect(audioRecognition.onEndOfSpeech).toHaveBeenCalledWith(1400, undefined, true);
  });

  it('forwards endpointingOpts into the live audioRecognition instance', () => {
    const audioRecognition = {
      updateOptions: vi.fn(),
    };

    const fakeActivity = {
      toolChoice: null,
      logger: {
        warn: vi.fn(),
      },
      realtimeSession: undefined,
      turnDetectionMode: 'vad',
      isDefaultInterruptionByAudioActivityEnabled: true,
      isInterruptionByAudioActivityEnabled: true,
      agentSession: {
        agentState: 'listening',
      },
      audioRecognition,
      endpointingOptions: {
        mode: 'fixed',
        minDelay: 300,
        maxDelay: 1000,
      },
    };

    const updateOptions = (AgentActivity.prototype as any).updateOptions as (
      this: unknown,
      options: Record<string, unknown>,
    ) => void;

    updateOptions.call(fakeActivity, {
      endpointingOpts: {
        mode: 'dynamic',
        minDelay: 500,
        maxDelay: 2000,
      },
    });

    expect(audioRecognition.updateOptions).toHaveBeenCalledTimes(1);
    const [{ endpointing }] = audioRecognition.updateOptions.mock.calls[0];
    expect(endpointing).toBeInstanceOf(DynamicEndpointing);
    expect(endpointing.minDelay).toBe(500);
    expect(endpointing.maxDelay).toBe(2000);
  });
});
