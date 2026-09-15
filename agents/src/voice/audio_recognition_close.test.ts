// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { Task } from '../utils.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';

type AudioRecognitionInternals = AudioRecognition & {
  bounceEOUTask?: Task<void>;
  commitUserTurnTask?: Task<void>;
  logger: {
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
};

function createRecognition(): AudioRecognitionInternals {
  const hooks: RecognitionHooks = {
    onInterruption: vi.fn(),
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onPreemptiveGeneration: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: vi.fn(async () => true),
  };
  const recognition = new AudioRecognition({
    recognitionHooks: hooks,
  }) as AudioRecognitionInternals;
  recognition.logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
  return recognition;
}

describe('AudioRecognition close', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it.each(['commitUserTurnTask', 'bounceEOUTask'] as const)(
    'waits for pending %s',
    async (taskProperty) => {
      const recognition = createRecognition();
      let release!: () => void;
      let taskSignal!: AbortSignal;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const task = Task.from(async ({ signal }) => {
        taskSignal = signal;
        await pending;
      });
      recognition[taskProperty] = task;

      const closePromise = recognition.close();
      await Promise.resolve();

      expect(taskSignal.aborted).toBe(false);
      expect(task.done).toBe(false);

      release();
      await closePromise;
      expect(task.done).toBe(true);
    },
  );

  it.each([
    ['commitUserTurnTask', 'error while committing the final user turn on close'],
    ['bounceEOUTask', 'error while completing the final user turn on close'],
  ] as const)('logs a type-only warning when %s fails', async (taskProperty, warning) => {
    const recognition = createRecognition();
    let reject!: (error: Error) => void;
    const failed = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    recognition[taskProperty] = Task.from(async () => failed);

    const closePromise = recognition.close();
    reject(new TypeError('turn task failed'));
    await closePromise;

    expect(recognition.logger.warn).toHaveBeenCalledOnce();
    expect(recognition.logger.warn).toHaveBeenCalledWith({ errorType: 'TypeError' }, warning);
    expect(recognition.logger.error).not.toHaveBeenCalled();
  });
});
