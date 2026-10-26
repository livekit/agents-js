// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError } from '../_exceptions.js';
import { initializeLogger, log } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { STTPipeline } from './audio_recognition.js';
import type { STTNode } from './io.js';

const finalTranscript: SpeechEvent = {
  type: SpeechEventType.FINAL_TRANSCRIPT,
  alternatives: [{ text: 'hello', startTime: 0, endTime: 0, confidence: 1 }],
};

function erroring(error: Error) {
  return new ReadableStream<SpeechEvent | string>({
    start(controller) {
      controller.error(error);
    },
  });
}

function yielding(event: SpeechEvent) {
  return new ReadableStream<SpeechEvent | string>({
    start(controller) {
      controller.enqueue(event);
    },
  });
}

describe('STTPipeline recovery after an exhausted retry budget', () => {
  initializeLogger({ pretty: false, level: 'silent' });
  afterEach(() => vi.restoreAllMocks());

  it('recreates the STT stream after a connection failure and keeps delivering events', async () => {
    const startedAt = Date.now();
    const event = { ...finalTranscript };
    let calls = 0;
    const sttNode: STTNode = async () => {
      calls += 1;
      return calls === 1
        ? erroring(new APIConnectionError({ message: 'retry budget exhausted' }))
        : yielding(event);
    };

    const pipeline = new STTPipeline(sttNode);
    const reader = pipeline.eventChannel.stream().getReader();
    try {
      const { value } = await reader.read();
      expect(value).toMatchObject(finalTranscript);
      expect(value?.createdAt).toBeGreaterThanOrEqual(startedAt);
      expect(value?.createdAt).toBeLessThanOrEqual(Date.now());
      expect(calls).toBe(2);
    } finally {
      reader.releaseLock();
      await pipeline.close();
    }
  });

  it('does not recreate the stream while the session is closing', async () => {
    let calls = 0;
    const sttNode: STTNode = async () => {
      calls += 1;
      return erroring(new APIConnectionError({ message: 'retry budget exhausted' }));
    };

    const pipeline = new STTPipeline(sttNode, { isClosing: () => true });
    const reader = pipeline.eventChannel.stream().getReader();
    try {
      // the pump stops and closes the event channel instead of reconnecting
      expect(await reader.read()).toEqual({ value: undefined, done: true });
      expect(calls).toBe(1);
    } finally {
      reader.releaseLock();
      await pipeline.close();
    }
  });

  it('logs and stops on any error that is not a connection failure', async () => {
    const error = new Error('not a provider failure');
    const errorLog = vi.spyOn(log(), 'error');
    let calls = 0;
    const sttNode: STTNode = async () => {
      calls += 1;
      return erroring(error);
    };

    const pipeline = new STTPipeline(sttNode);
    const reader = pipeline.eventChannel.stream().getReader();
    try {
      expect(await reader.read()).toEqual({ value: undefined, done: true });
      expect(calls).toBe(1);
      expect(errorLog).toHaveBeenCalledExactlyOnceWith({ err: error }, 'STT pipeline failed');
    } finally {
      reader.releaseLock();
      await pipeline.close();
    }
  });

  it.each(['throw', 'reject'] as const)('logs a node startup failure (%s)', async (failure) => {
    const error = new Error('STT node failed to start');
    const errorLog = vi.spyOn(log(), 'error');
    const sttNode = vi.fn(() => {
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    });
    const pipeline = new STTPipeline(sttNode);
    const reader = pipeline.eventChannel.stream().getReader();
    try {
      expect(await reader.read()).toEqual({ value: undefined, done: true });
      expect(sttNode).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledExactlyOnceWith({ err: error }, 'STT pipeline failed');
    } finally {
      reader.releaseLock();
      await pipeline.close();
    }
  });
});
