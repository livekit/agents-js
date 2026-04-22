// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { AudioRecognition, type RecognitionHooks, STTPipeline } from './audio_recognition.js';
import type { STTNode } from './io.js';
import { createEndpointing } from './turn_config/endpointing.js';

function createHooks() {
  const hooks: RecognitionHooks = {
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

  return hooks;
}

async function flushTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean, timeoutMs = 200) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await flushTasks();
  }
}

function createRecognition(sttNode: STTNode, hooks = createHooks()) {
  return {
    hooks,
    recognition: new AudioRecognition({
      recognitionHooks: hooks,
      stt: sttNode,
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
      endpointing: createEndpointing({ mode: 'fixed', minDelay: 0, maxDelay: 0 }),
    }),
  };
}

describe('AudioRecognition STT pipeline handoff', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('reuses an injected STT pipeline instead of opening a second STT stream', async () => {
    let sttNodeCalls = 0;

    const sttNode: STTNode = async () => {
      sttNodeCalls += 1;
      return new ReadableStream<SpeechEvent | string>({
        start() {},
      });
    };

    const pipeline = new STTPipeline(sttNode);
    const { recognition } = createRecognition(sttNode);

    try {
      await recognition.start({ sttPipeline: pipeline });
      await waitFor(() => sttNodeCalls === 1);

      expect(sttNodeCalls).toBe(1);
    } finally {
      await recognition.close();
      await pipeline.close();
    }
  });

  it('detaches the pipeline so a new consumer can receive subsequent STT events', async () => {
    let controller: ReadableStreamDefaultController<SpeechEvent | string> | undefined;

    const sttNode: STTNode = async () =>
      new ReadableStream<SpeechEvent | string>({
        start(ctrl) {
          controller = ctrl;
        },
      });

    const pipeline = new STTPipeline(sttNode);
    const first = createRecognition(sttNode);
    const second = createRecognition(sttNode);

    try {
      await first.recognition.start({ sttPipeline: pipeline });
      await waitFor(() => controller !== undefined);

      const detachedPipeline = await (first.recognition as any).detachSttPipeline();
      await first.recognition.close();

      await second.recognition.start({ sttPipeline: detachedPipeline });
      await flushTasks();

      controller?.enqueue({
        type: SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [{ text: 'reused pipeline', confidence: 0.9 }],
      });
      await waitFor(() => second.hooks.onFinalTranscript.mock.calls.length === 1);

      expect(first.hooks.onFinalTranscript).not.toHaveBeenCalled();
      expect(second.hooks.onFinalTranscript).toHaveBeenCalledTimes(1);
    } finally {
      controller?.close();
      await first.recognition.close();
      await second.recognition.close();
      await pipeline.close();
    }
  });

  it('resets handoff-sensitive STT state when attaching a pipeline', async () => {
    const sttNode: STTNode = async () =>
      new ReadableStream<SpeechEvent | string>({
        start() {},
      });

    const pipeline = new STTPipeline(sttNode);
    const { recognition } = createRecognition(sttNode);

    (recognition as any).transcriptBuffer = [
      { type: SpeechEventType.FINAL_TRANSCRIPT, alternatives: [{ text: 'stale transcript' }] },
    ];
    (recognition as any).ignoreUserTranscriptUntil = Date.now();
    (recognition as any)._inputStartedAt = Date.now();

    try {
      await recognition.start({ sttPipeline: pipeline });

      expect((recognition as any).transcriptBuffer).toEqual([]);
      expect((recognition as any).ignoreUserTranscriptUntil).toBeUndefined();
      expect((recognition as any)._inputStartedAt).toBeUndefined();
    } finally {
      await recognition.close();
      await pipeline.close();
    }
  });

  it('recreates the owned STT pipeline when clearing the user turn', async () => {
    let sttNodeCalls = 0;

    const sttNode: STTNode = async () => {
      sttNodeCalls += 1;
      return new ReadableStream<SpeechEvent | string>({
        start() {},
      });
    };

    const { recognition } = createRecognition(sttNode);

    try {
      await recognition.start();
      await waitFor(() => sttNodeCalls === 1);

      recognition.clearUserTurn();

      await waitFor(() => sttNodeCalls === 2);
    } finally {
      await recognition.close();
    }
  });

  it('keeps an STT pipeline alive across overlapping clearUserTurn calls', async () => {
    let sttNodeCalls = 0;

    const sttNode: STTNode = async () => {
      sttNodeCalls += 1;
      return new ReadableStream<SpeechEvent | string>({
        start() {},
      });
    };

    const { recognition } = createRecognition(sttNode);

    try {
      await recognition.start();
      await waitFor(() => sttNodeCalls === 1);

      recognition.clearUserTurn();
      recognition.clearUserTurn();

      await flushTasks();
      await flushTasks();
      await flushTasks();

      expect((recognition as any).sttPipeline).toBeDefined();
    } finally {
      await recognition.close();
    }
  });

  it('does not recreate a new pipeline after ownership was detached for handoff', async () => {
    let sttNodeCalls = 0;

    const sttNode: STTNode = async () => {
      sttNodeCalls += 1;
      return new ReadableStream<SpeechEvent | string>({
        start() {},
      });
    };

    const { recognition } = createRecognition(sttNode);

    try {
      await recognition.start();
      await waitFor(() => sttNodeCalls === 1);

      await (recognition as any).detachSttPipeline();
      recognition.clearUserTurn();

      await flushTasks();
      await flushTasks();
      await flushTasks();

      expect(sttNodeCalls).toBe(1);
      expect((recognition as any).sttPipeline).toBeUndefined();
    } finally {
      await recognition.close();
    }
  });
});
