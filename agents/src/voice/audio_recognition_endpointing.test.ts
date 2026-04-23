// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { BaseEndpointing, DynamicEndpointing } from './endpointing.js';
import type { STTNode } from './io.js';

class SpyEndpointing extends BaseEndpointing {
  startOfSpeechCalls: Array<{ startedAt: number; overlapping: boolean }> = [];
  endOfSpeechCalls: Array<{ endedAt: number; shouldIgnore: boolean }> = [];
  agentSpeechStartedAt: number[] = [];
  agentSpeechEndedAt: number[] = [];

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    super.onStartOfSpeech(startedAt, overlapping);
    this.startOfSpeechCalls.push({ startedAt, overlapping });
  }

  override onEndOfSpeech(endedAt: number, shouldIgnore = false): void {
    super.onEndOfSpeech(endedAt, shouldIgnore);
    this.endOfSpeechCalls.push({ endedAt, shouldIgnore });
  }

  override onStartOfAgentSpeech(startedAt: number): void {
    this.agentSpeechStartedAt.push(startedAt);
  }

  override onEndOfAgentSpeech(endedAt: number): void {
    this.agentSpeechEndedAt.push(endedAt);
  }
}

class FakeVADStream extends (Object as unknown as { new (): VADStream }) {
  private events: VADEvent[];
  private index = 0;

  constructor(events: VADEvent[]) {
    super();
    this.events = events;
  }

  updateInputStream() {}
  detachInputStream() {}
  close() {}

  [Symbol.asyncIterator]() {
    return this;
  }

  async next(): Promise<IteratorResult<VADEvent>> {
    if (this.index >= this.events.length) {
      return { done: true, value: undefined };
    }
    return { done: false, value: this.events[this.index++]! };
  }
}

class FakeVAD extends VAD {
  label = 'fake-vad';

  constructor(private events: VADEvent[]) {
    super({ updateInterval: 1 });
  }

  stream(): VADStream {
    return new FakeVADStream(this.events) as VADStream;
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

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('AudioRecognition endpointing integration', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes STT and agent speech lifecycle through endpointing', async () => {
    const endpointing = new SpyEndpointing(0, 0);
    const sttEvents: SpeechEvent[] = [
      { type: SpeechEventType.START_OF_SPEECH },
      { type: SpeechEventType.END_OF_SPEECH },
    ];

    const sttNode: STTNode = async () =>
      new ReadableStream<SpeechEvent | string>({
        start(controller) {
          for (const event of sttEvents) {
            controller.enqueue(event);
          }
          controller.close();
        },
      });

    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      stt: sttNode,
      turnDetectionMode: 'stt',
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
      endpointing,
    });

    try {
      await recognition.onStartOfAgentSpeech();
      await recognition.onEndOfAgentSpeech(Date.now());
      await recognition.start();
      await flushTasks();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(endpointing.agentSpeechStartedAt).toHaveLength(1);
      expect(endpointing.agentSpeechEndedAt).toHaveLength(1);
      expect(endpointing.startOfSpeechCalls).toHaveLength(1);
      expect(endpointing.startOfSpeechCalls[0]).toMatchObject({ overlapping: false });
      expect(endpointing.endOfSpeechCalls).toHaveLength(1);
      expect(endpointing.endOfSpeechCalls[0]).toMatchObject({ shouldIgnore: false });
    } finally {
      await recognition.close();
    }
  });

  it('routes VAD timestamps through endpointing with latency correction', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const endpointing = new SpyEndpointing(0, 0);
    const vadEvents: VADEvent[] = [
      {
        type: VADEventType.START_OF_SPEECH,
        samplesIndex: 0,
        timestamp: 10_000,
        speechDuration: 100,
        silenceDuration: 0,
        frames: [],
        probability: 0,
        inferenceDuration: 20,
        speaking: true,
        rawAccumulatedSilence: 0,
        rawAccumulatedSpeech: 0,
      },
      {
        type: VADEventType.END_OF_SPEECH,
        samplesIndex: 0,
        timestamp: 10_100,
        speechDuration: 100,
        silenceDuration: 40,
        frames: [],
        probability: 0,
        inferenceDuration: 20,
        speaking: false,
        rawAccumulatedSilence: 0,
        rawAccumulatedSpeech: 0,
      },
    ];

    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      vad: new FakeVAD(vadEvents),
      turnDetectionMode: 'vad',
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
      endpointing,
    });

    try {
      await recognition.start();
      await vi.advanceTimersByTimeAsync(0);
      await flushTasks();

      expect(endpointing.startOfSpeechCalls[0]?.startedAt).toBe(9880);
      expect(endpointing.endOfSpeechCalls[0]?.endedAt).toBe(9940);
    } finally {
      await recognition.close();
    }
  });

  it('replaces endpointing on updateOptions and resets learned state by replacement', () => {
    const learned = new DynamicEndpointing(0.3, 1.0, 0.5);
    learned.onEndOfSpeech(100.0);
    learned.onStartOfSpeech(100.4);
    learned.onEndOfSpeech(100.5);
    expect(learned.minDelay).toBeCloseTo(0.35, 5);

    const replacement = new DynamicEndpointing(0.3, 1.0, 0.5);
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      minEndpointingDelay: learned.minDelay,
      maxEndpointingDelay: learned.maxDelay,
      endpointing: learned,
    });

    recognition.updateOptions({ turnDetection: undefined, endpointing: replacement });

    expect((recognition as any).endpointing).toBe(replacement);
    expect(((recognition as any).endpointing as DynamicEndpointing).minDelay).toBe(0.3);
  });
});
